#!/usr/bin/env node
/**
 * 端到端导航 / 侧边栏验收脚本（对应 docs/web-nav-sidebar-acceptance.md §4 的 A/B/C）。
 *
 * 用 `agent-browser` CLI 驱动一个**独立会话**（默认 kbux-e2e-<pid>-<profile>），
 * 桌面 1280×900 与移动 390×844 各跑一遍，全部用 `eval` 读取 DOM / 几何 / 性能数据做断言，
 * 不依赖截图（模型没有图像输入）。
 *
 * 用法：
 *   node web/e2e/nav-check.mjs                          # 双端，默认 http://127.0.0.1:8787
 *   node web/e2e/nav-check.mjs --base http://127.0.0.1:8787 --out docs/evidence/after.json
 *   node web/e2e/nav-check.mjs --profile desktop        # 只跑桌面
 *   node web/e2e/nav-check.mjs --verbose                # 打印每条 agent-browser 命令
 *
 * 退出码：0 = 所有机器断言通过；1 = 有失败或脚本自身出错。
 *
 * 前置：`wrangler dev` 已在 --base 上跑（默认 127.0.0.1:8787，本机 36 篇真实笔记），
 * 且 `agent-browser` 已安装（`agent-browser --version`）。详见 web/e2e/README.md。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECTOR = resolve(HERE, 'collector.js');
const IS_WIN = process.platform === 'win32';

/** 验收条款（逐条机器断言；title 用于报告）。 */
const CRITERIA = {
  A1: '巡览全程 performance navigation 条目=1，__kbBootAt/timeOrigin 不变',
  A2: 'app-shell/topbar/aside.sidebar 引用不变、从未被移除、无 .boot-loading 整页 spinner',
  A3: '顶栏搜索框值跨导航保留、未被抢焦点；搜索页保留 ?q=',
  A4: '.page-content 导航期间从不为空，aria-busy 加载期为 true、完成后清除',
  A5: 'push 进入回顶；后退/前进恢复各自 scrollY；#hash 深链渲染后滚到锚点',
  A6: 'document.title 随路由更新；未知路由在 shell 内渲染「页面不存在」（含侧边栏与搜索框）',
  B1: '桌面 /d/ 页有可见 aside.sidebar（宽>100、在内容左侧），树节点数>0',
  B2: '当前文档 .tree-doc[aria-current=page] 唯一、祖先 details 全开、节点在侧边栏可视区',
  B3: 'home→doc→另一篇 doc：侧边栏 DOM 引用不变、scrollTop 不被重置、/api/tree ≤1 次',
  B4: '/、/search、/reports 有侧边栏；/edit/ 无侧边栏（宽版）；移动端侧边栏隐藏并给「目录」按钮',
  B5: '抽屉：Esc/遮罩/点链接都关闭、焦点回触发按钮、无残留 no-scroll、（窄屏）',
  B6: '404 / 页面级错误态仍在 shell 内并保留侧边栏',
  B7: '目录树加载失败：侧边栏显示可重试错误，正文仍可用；重试后树恢复',
  C4: '巡览全程无 console.error / pageerror / 非预期 4xx-5xx',
  C5: '导航后焦点落在内容区；侧边栏 nav[aria-label]；抽屉 role=dialog aria-modal',
};

const ORDER = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'C4', 'C5'];
const PROFILES = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 390, height: 844 },
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const js = (value) => JSON.stringify(value);
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function syncSleep(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* ignore */
  }
}

function short(value, limit = 240) {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function parseArgs(argv) {
  const opts = {
    base: process.env.NAV_CHECK_BASE || 'http://127.0.0.1:8787',
    out: resolve(HERE, 'reports/last.json'),
    profile: 'both',
    timeout: 20000,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--base':
        opts.base = argv[++i];
        break;
      case '--out':
        opts.out = resolve(process.cwd(), argv[++i]);
        break;
      case '--profile':
        opts.profile = argv[++i];
        break;
      case '--timeout':
        opts.timeout = Number(argv[++i]) || opts.timeout;
        break;
      case '--verbose':
        opts.verbose = true;
        break;
      case '--help':
      case '-h':
        console.log('用法: node web/e2e/nav-check.mjs [--base <url>] [--out <json>] [--profile desktop|mobile|both] [--timeout ms] [--verbose]');
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  if (!['desktop', 'mobile', 'both'].includes(opts.profile)) {
    throw new Error(`--profile 只能是 desktop|mobile|both，收到 ${opts.profile}`);
  }
  opts.base = String(opts.base).replace(/\/+$/, '');
  return opts;
}

/** 与 web/src/router.ts 保持一致（脚本单独可跑，不依赖构建产物）。 */
function encodePath(path) {
  return String(path)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
const docUrl = (path) => `/d/${encodePath(path)}/`;
const editUrl = (path, isNew = false) => `/edit/${encodePath(path)}/${isNew ? '?new=1' : ''}`;

/* ------------------------------------------------------------------ */
/* agent-browser 封装                                                  */
/* ------------------------------------------------------------------ */

class Browser {
  constructor(session, options = {}) {
    this.session = session;
    this.verbose = Boolean(options.verbose);
  }

  raw(args, { input, timeout = 60000, allowFail = false } = {}) {
    const finalArgs = IS_WIN ? args.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : args;
    const env = { ...process.env, AGENT_BROWSER_SESSION: this.session };
    const result = spawnSync('agent-browser', finalArgs, {
      shell: IS_WIN,
      input,
      encoding: 'utf8',
      timeout,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = result.stdout || '';
    const stderr = result.stderr || '';
    if (this.verbose) {
      const shown = input ? `${finalArgs.join(' ')} <<< ${short(input, 80)}` : finalArgs.join(' ');
      console.error(`  [ab:${this.session}] ${shown} → ${result.status}`);
    }
    if (result.error) {
      if (allowFail) return { status: -1, stdout, stderr: String(result.error.message || result.error) };
      throw new Error(`agent-browser 无法执行（${finalArgs[0]}）：${short(result.error.message || result.error)}`);
    }
    if (result.status !== 0) {
      const message = `agent-browser ${finalArgs[0]} 失败 (exit ${result.status})：${short((stderr || stdout).trim())}`;
      if (allowFail) return { status: result.status, stdout, stderr };
      throw new Error(message);
    }
    return { status: 0, stdout, stderr };
  }

  jsonPayload(args, options) {
    const { stdout } = this.raw(args, options);
    const candidates = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('{'));
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      try {
        const payload = JSON.parse(candidates[i]);
        if (payload && typeof payload === 'object' && ('success' in payload || 'data' in payload)) return payload;
      } catch {
        /* try next */
      }
    }
    try {
      return JSON.parse(stdout.trim());
    } catch {
      throw new Error(`无法解析 agent-browser JSON 输出：${short(stdout, 300)}`);
    }
  }

  data(args, options) {
    const payload = this.jsonPayload(args, options);
    if (payload.success === false) throw new Error(`agent-browser 返回错误：${short(JSON.stringify(payload.error))}`);
    return payload.data ?? {};
  }

  eval(script, { timeout = 60000, retry = 1, fallback } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retry; attempt += 1) {
      try {
        const data = this.data(['eval', '--stdin', '--json'], { input: script, timeout });
        return data.result;
      } catch (error) {
        lastError = error;
        if (attempt < retry) syncSleep(250);
      }
    }
    if (fallback !== undefined) return fallback;
    throw lastError;
  }

  open(url) {
    this.raw(['open', url, '--json', '--init-script', COLLECTOR], { timeout: 90000 });
  }

  click(selector) {
    this.raw(['click', selector], { timeout: 30000 });
  }

  press(key) {
    this.raw(['press', key], { timeout: 30000 });
  }

  back() {
    this.raw(['back'], { timeout: 30000 });
  }

  forward() {
    this.raw(['forward'], { timeout: 30000 });
  }

  setViewport(width, height) {
    this.raw(['set', 'viewport', String(width), String(height)], { timeout: 30000 });
  }

  close() {
    this.raw(['close'], { timeout: 30000, allowFail: true });
  }

  requests() {
    const data = this.data(['network', 'requests', '--json'], { timeout: 60000 });
    return Array.isArray(data.requests) ? data.requests : [];
  }

  routeAbort(pattern) {
    this.raw(['network', 'route', pattern, '--abort'], { timeout: 30000 });
  }

  unroute(pattern) {
    this.raw(pattern ? ['network', 'unroute', pattern] : ['network', 'unroute'], { timeout: 30000, allowFail: true });
  }

  async waitFor(condition, { label = '条件', timeout = 20000 } = {}) {
    const script = `(async () => {
      const started = Date.now();
      while (Date.now() - started < ${timeout}) {
        let ok = false;
        try { ok = Boolean(${condition}); } catch (error) { ok = false; }
        if (ok) return { ok: true, waited: Date.now() - started };
        await new Promise((r) => setTimeout(r, 60));
      }
      return { ok: false, waited: Date.now() - started };
    })()`;
    const result = this.eval(script, { timeout: timeout + 15000, retry: 0 });
    if (!result || !result.ok) throw new Error(`等待超时（${label}，${timeout}ms）`);
    return result.waited;
  }

  settle(ms = 250) {
    this.eval(`new Promise((r) => setTimeout(r, ${ms}))`, { timeout: Math.max(ms + 20000, 20000), retry: 0 });
  }
}

/* ------------------------------------------------------------------ */
/* 页面侧测量脚本                                                      */
/* ------------------------------------------------------------------ */

const BOOT_SCRIPT = `(() => {
  const shell = document.querySelector('.app-shell');
  const topbar = document.querySelector('.topbar');
  const aside = document.querySelector('aside.sidebar');
  const content = document.querySelector('.page-content');
  window.__e2eRefs = { shell, topbar, sidebar: aside, content };
  window.__e2eBoot = {
    navCount: performance.getEntriesByType('navigation').length,
    timeOrigin: performance.timeOrigin,
    bootAt: (typeof window.__kbBootAt === 'undefined' ? null : window.__kbBootAt),
    at: Date.now(),
  };
  const rect = aside ? aside.getBoundingClientRect() : null;
  const btn = document.querySelector('.nav-tree-btn');
  const btnRect = btn ? btn.getBoundingClientRect() : null;
  return {
    shell: !!shell,
    topbar: !!topbar,
    sidebar: !!aside,
    content: !!content,
    sidebarWidth: rect ? Math.round(rect.width) : 0,
    sidebarDisplay: aside ? getComputedStyle(aside).display : null,
    drawerBtn: !!btn,
    drawerBtnVisible: !!(btnRect && btnRect.width > 0 && btnRect.height > 0 && getComputedStyle(btn).display !== 'none'),
    treeDocs: aside ? aside.querySelectorAll('a.tree-doc').length : 0,
    searchInput: !!document.querySelector('.search-input'),
    title: document.title,
    navCount: window.__e2eBoot.navCount,
    timeOrigin: window.__e2eBoot.timeOrigin,
    bootAt: window.__e2eBoot.bootAt,
    scrollY: window.scrollY,
    pageHeight: document.documentElement.scrollHeight,
  };
})()`;

const MEASURE_SCRIPT = `(() => {
  const q = (selector) => document.querySelector(selector);
  const refs = window.__e2eRefs || {};
  const shell = q('.app-shell');
  const topbar = q('.topbar');
  const aside = q('aside.sidebar');
  const content = q('.page-content');
  const input = q('.search-input');
  const active = document.activeElement;
  const asideRect = aside ? aside.getBoundingClientRect() : null;
  const contentRect = content ? content.getBoundingClientRect() : null;
  const currentLinks = aside ? [...aside.querySelectorAll('.tree-doc[aria-current="page"]')] : [];
  const currentLink = currentLinks[0] || null;
  const linkRect = currentLink ? currentLink.getBoundingClientRect() : null;
  const ancestorDetails = aside && currentLink
    ? [...aside.querySelectorAll('details.tree-dir')].filter((node) => node.contains(currentLink))
    : [];
  const drawer = q('.tree-drawer');
  const btn = q('.nav-tree-btn');
  const btnRect = btn ? btn.getBoundingClientRect() : null;
  const busy = window.__e2e || {};
  return {
    path: location.pathname,
    search: location.search,
    hash: location.hash,
    title: document.title,
    shell: !!shell,
    topbar: !!topbar,
    content: !!content,
    shellSame: !!shell && shell === refs.shell,
    topbarSame: !!topbar && topbar === refs.topbar,
    sidebarExists: !!aside,
    sidebarSame: !!aside && aside === refs.sidebar,
    sidebarWidth: asideRect ? Math.round(asideRect.width) : 0,
    sidebarDisplay: aside ? getComputedStyle(aside).display : null,
    sidebarLeft: asideRect ? Math.round(asideRect.left) : null,
    sidebarScrollTop: aside ? aside.scrollTop : null,
    sidebarScrollHeight: aside ? aside.scrollHeight : 0,
    contentLeft: contentRect ? Math.round(contentRect.left) : null,
    contentChildren: content ? content.childElementCount : -1,
    contentText: content ? (content.textContent || '').slice(0, 160) : '',
    ariaBusy: content ? content.getAttribute('aria-busy') : null,
    searchInput: !!input,
    searchValue: input ? input.value : null,
    activeTag: active ? active.tagName : null,
    activeInContent: !!(content && active && content.contains(active)),
    treeDocCount: aside ? aside.querySelectorAll('a.tree-doc').length : 0,
    currentCount: currentLinks.length,
    currentPath: currentLink ? currentLink.getAttribute('data-doc-path') : null,
    ancestorsOpen: ancestorDetails.map((node) => node.open),
    currentVisible: !!(aside && linkRect && asideRect && linkRect.top >= asideRect.top - 2 && linkRect.bottom <= asideRect.bottom + 2),
    scrollY: window.scrollY,
    pageHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    bootLoading: !!q('.boot-loading'),
    sidebarError: !!q('.sidebar-error'),
    sidebarErrorRetry: !!q('.sidebar-error button'),
    drawer: !!drawer,
    drawerRole: drawer ? drawer.getAttribute('role') : null,
    drawerAriaModal: drawer ? drawer.getAttribute('aria-modal') : null,
    drawerTreeDocs: drawer ? drawer.querySelectorAll('a.tree-doc').length : 0,
    drawerCurrentCount: drawer ? drawer.querySelectorAll('.tree-doc[aria-current="page"]').length : 0,
    activeInDrawer: !!(drawer && active && drawer.contains(active)),
    noScroll: document.documentElement.classList.contains('no-scroll'),
    drawerBtn: !!btn,
    drawerBtnVisible: !!(btnRect && btnRect.width > 0 && btnRect.height > 0 && getComputedStyle(btn).display !== 'none'),
    shellWide: !!(shell && shell.classList.contains('app-shell-wide')),
    bodySidebar: (() => { const body = q('.app-body'); return body ? body.dataset.sidebar || null : null; })(),
    docTitleText: (() => { const node = q('.doc-title, .page-title'); return node ? (node.textContent || '').slice(0, 100) : null; })(),
    navCount: performance.getEntriesByType('navigation').length,
    timeOrigin: performance.timeOrigin,
    bootAt: (typeof window.__kbBootAt === 'undefined' ? null : window.__kbBootAt),
    shellRemovals: busy.shellRemovals || [],
    bootLoadingAdded: busy.bootLoadingAdded || 0,
    busyTrue: busy.busyTrue || 0,
    busyFalse: busy.busyFalse || 0,
    emptyContentSamples: busy.emptyContentSamples || 0,
  };
})()`;

const READ_COLLECTOR_SCRIPT = `(() => {
  const state = window.__e2e;
  if (!state) return null;
  const snapshot = {
    consoleErrors: state.consoleErrors.slice(),
    pageErrors: state.pageErrors.slice(),
    rejections: state.rejections.slice(),
    bootLoadingAdded: state.bootLoadingAdded,
    shellRemovals: state.shellRemovals.slice(),
    busyTrue: state.busyTrue,
    busyFalse: state.busyFalse,
    emptyContentSamples: state.emptyContentSamples,
    contentReplacements: state.contentReplacements,
  };
  state.consoleErrors = [];
  state.pageErrors = [];
  state.rejections = [];
  return snapshot;
})()`;

/* ------------------------------------------------------------------ */
/* 断言记录                                                            */
/* ------------------------------------------------------------------ */

class Recorder {
  constructor(profile) {
    this.profile = profile;
    this.items = new Map();
  }

  add(id, ok, detail, measured) {
    if (!CRITERIA[id]) throw new Error(`未知验收条款 ${id}`);
    const existing = this.items.get(id);
    if (!existing) {
      this.items.set(id, {
        id,
        title: CRITERIA[id],
        status: ok ? 'pass' : 'fail',
        details: [detail],
        measured: measured === undefined ? null : measured,
      });
      return;
    }
    existing.details.push(detail);
    if (!ok) existing.status = 'fail';
    if (measured !== undefined) {
      existing.measured = existing.measured && typeof existing.measured === 'object' ? { ...existing.measured, ...measured } : measured;
    }
  }

  skip(id, detail) {
    if (this.items.has(id)) return;
    this.items.set(id, { id, title: CRITERIA[id], status: 'skip', details: [detail], measured: null });
  }

  has(id) {
    return this.items.has(id);
  }

  finalize(requiredIds) {
    for (const id of requiredIds) {
      if (!this.items.has(id)) this.items.set(id, { id, title: CRITERIA[id], status: 'fail', details: ['未执行（前置步骤失败）'], measured: null });
    }
  }

  list() {
    return [...this.items.values()].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));
  }
}

/* ------------------------------------------------------------------ */
/* 断言 / 导航辅助                                                     */
/* ------------------------------------------------------------------ */

function identityOk(measure) {
  return (
    measure.shellSame &&
    measure.topbarSame &&
    measure.sidebarExists &&
    measure.sidebarSame &&
    measure.shellRemovals.length === 0 &&
    measure.bootLoadingAdded === 0
  );
}

function identityDetail(measure) {
  return `shellSame=${measure.shellSame} topbarSame=${measure.topbarSame} sidebarSame=${measure.sidebarSame} 被移除=[${measure.shellRemovals.join(', ')}] bootSpinner=${measure.bootLoadingAdded}`;
}

function contentOk(measure) {
  return measure.content && measure.contentChildren > 0 && measure.ariaBusy === null && measure.emptyContentSamples === 0;
}

function contentDetail(measure) {
  return `内容子节点=${measure.contentChildren} aria-busy=${measure.ariaBusy} 导航中空内容采样=${measure.emptyContentSamples} busy true/false=${measure.busyTrue}/${measure.busyFalse}`;
}

async function measure(br) {
  return br.eval(MEASURE_SCRIPT, { retry: 1 });
}

async function navActive(br, active) {
  await br.eval(`(() => { window.__e2eNavActive = ${active ? 'true' : 'false'}; return true; })()`, { retry: 0 });
}

async function waitPage(br, path, { marker, title, label, settle = 450 } = {}) {
  let condition = `location.pathname === ${js(path)} && !!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`;
  if (marker) condition += ` && !!document.querySelector(${js(marker)})`;
  if (title) condition += ` && document.title.includes(${js(title)})`;
  await br.waitFor(condition, { label: label || path, timeout: 20000 });
  await br.settle(settle);
}

async function clickJs(br, expression, label) {
  const result = await br.eval(
    `(() => { const node = (${expression}); if (!node) return { ok: false }; node.click(); return { ok: true, href: node.getAttribute ? node.getAttribute('href') : null }; })()`,
    { retry: 0 },
  );
  if (!result || !result.ok) throw new Error(`找不到可点击元素：${label}`);
  return result;
}

const docLinkExpr = (path) => `[...document.querySelectorAll('a[href]')].find((node) => node.getAttribute('href') === ${js(docUrl(path))})`;
const treeLinkExpr = (path) => `[...document.querySelectorAll('a.tree-doc')].find((node) => node.dataset.docPath === ${js(path)})`;
const navLinkExpr = (href) => `document.querySelector(${js(`.nav a[href="${href}"]`)})`;

async function readCollector(br) {
  try {
    return await br.eval(READ_COLLECTOR_SCRIPT, { retry: 1 });
  } catch {
    return null;
  }
}

function mergeErrors(target, snapshot, phase) {
  if (!snapshot) return;
  for (const message of snapshot.consoleErrors || []) target.consoleErrors.push({ phase, message });
  for (const message of snapshot.pageErrors || []) target.pageErrors.push({ phase, message });
  for (const message of snapshot.rejections || []) target.rejections.push({ phase, message });
}

/* ------------------------------------------------------------------ */
/* 站点准备：健康检查、树、fixture                                     */
/* ------------------------------------------------------------------ */

async function collectBuildInfo(base) {
  const info = { base };
  try {
    const response = await fetch(`${base}/`, { headers: { accept: 'text/html' } });
    const html = await response.text();
    info.indexStatus = response.status;
    info.asset = (html.match(/assets\/(index-[^"']+\.js)/) || [])[1] || null;
    info.htmlTitle = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || null;
  } catch (error) {
    info.indexError = short(error);
  }
  try {
    const response = await fetch(`${base}/api/health`, { headers: { accept: 'application/json' } });
    info.healthStatus = response.status;
    info.health = await response.json();
  } catch (error) {
    info.healthError = short(error);
  }
  return info;
}

async function fetchTree(base) {
  const response = await fetch(`${base}/api/tree?limit=500`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET /api/tree 失败：HTTP ${response.status}`);
  const data = await response.json();
  const entries = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('/api/tree 返回空目录');
  return entries;
}

async function fetchDocRaw(base, path) {
  const response = await fetch(`${base}/api/docs/${encodePath(path)}`, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  const data = await response.json();
  return typeof data.raw === 'string' ? data.raw : null;
}

/** 选长文（用于滚动/锚点）与「带 wikilink 的长文」（用于 wikilink 导航）。 */
async function buildFixture(tree, base) {
  const sorted = [...tree].sort((a, b) => (b.size || 0) - (a.size || 0));
  const candidates = sorted.filter((entry) => (entry.size || 0) >= 4000).slice(0, 8);
  let tourDoc = sorted[0];
  for (const entry of candidates) {
    const raw = await fetchDocRaw(base, entry.path);
    if (raw && /\[\[[^\]]+\]\]/.test(raw)) {
      tourDoc = entry;
      break;
    }
  }
  const topDir = tourDoc.path.split('/')[0];
  const secondDoc = sorted.find((entry) => entry.path.split('/')[0] !== topDir) || sorted[1] || tourDoc;
  return {
    docsCount: tree.length,
    tourDoc: { path: tourDoc.path, title: tourDoc.title || tourDoc.path, size: tourDoc.size },
    scrollDoc: { path: tourDoc.path, title: tourDoc.title || tourDoc.path, size: tourDoc.size },
    secondDoc: { path: secondDoc.path, title: secondDoc.title || secondDoc.path, size: secondDoc.size },
  };
}

/* ------------------------------------------------------------------ */
/* 各阶段                                                              */
/* ------------------------------------------------------------------ */

async function phaseTour(br, ctx) {
  const { report, profile, fixture } = ctx;
  const { tourDoc, scrollDoc, secondDoc } = fixture;

  /* --- 首屏 --- */
  await waitPage(br, '/', { marker: '.main-column', title: '私有知识库', label: '首页' });
  const boot = await br.eval(BOOT_SCRIPT, { retry: 1 });
  ctx.boot = boot;
  report.add('A1', boot.navCount === 1, `启动时 navigation 条目=${boot.navCount}、timeOrigin=${Math.round(boot.timeOrigin)}`, {
    bootNavCount: boot.navCount,
    bootTimeOrigin: boot.timeOrigin,
    bootAt: boot.bootAt,
  });
  report.add('A2', boot.shell && boot.topbar && boot.sidebar, `首屏 shell/topbar/aside.sidebar=${boot.shell}/${boot.topbar}/${boot.sidebar}`, {
    bootTreeDocs: boot.treeDocs,
  });

  const typed = await br.eval(
    `(() => {
      const input = document.querySelector('.search-input');
      if (!input) return { ok: false };
      input.focus();
      input.value = ${js('压感')};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, focused: document.activeElement === input, value: input.value };
    })()`,
    { retry: 0 },
  );
  report.add('A3', Boolean(typed && typed.ok && typed.focused), `首页搜索框输入「压感」并聚焦：${typed && typed.ok}`, { typed });

  if (profile === 'desktop') {
    report.add(
      'B4',
      boot.sidebarWidth > 100 && boot.sidebarDisplay !== 'none' && boot.treeDocs > 0,
      `桌面首页侧边栏：宽=${boot.sidebarWidth} display=${boot.sidebarDisplay} 树节点=${boot.treeDocs}`,
      { homeSidebarWidth: boot.sidebarWidth, homeTreeDocs: boot.treeDocs },
    );
  } else {
    report.add(
      'B4',
      (boot.sidebarDisplay === 'none' || boot.sidebarWidth === 0) && boot.drawerBtnVisible,
      `移动端首页：侧边栏 display=${boot.sidebarDisplay} width=${boot.sidebarWidth}、目录按钮可见=${boot.drawerBtnVisible}`,
      { mobileHomeSidebarDisplay: boot.sidebarDisplay, mobileDrawerBtnVisible: boot.drawerBtnVisible },
    );
  }

  /* --- 首页 → 长文（真实链接点击） --- */
  await navActive(br, true);
  await clickJs(br, docLinkExpr(tourDoc.path), `首页文章链接 ${tourDoc.path}`);
  await waitPage(br, docUrl(tourDoc.path), { marker: '.doc-page', title: tourDoc.title, label: '进入文章' });
  await navActive(br, false);
  const doc = await measure(br);

  report.add('A2', identityOk(doc), `进入文章后：${identityDetail(doc)}`, { docIdentity: identityDetail(doc) });
  report.add('A4', contentOk(doc), `进入文章后：${contentDetail(doc)}`, { docBusyTrue: doc.busyTrue, docBusyFalse: doc.busyFalse });
  report.add(
    'A3',
    doc.searchValue === '压感' && doc.activeTag !== 'INPUT',
    `文章页搜索框值=${js(doc.searchValue)}、activeElement=${doc.activeTag}（不应是 INPUT/搜索框）`,
    { docSearchValue: doc.searchValue },
  );
  report.add('A6', doc.title !== '私有知识库' && doc.title.includes('私有知识库'), `文章页 title=${doc.title}`, { docTitle: doc.title });
  report.add('C5', doc.activeInContent, `导航后焦点在 .page-content 内=${doc.activeInContent}（activeElement=${doc.activeTag}）`, {
    docActiveElement: doc.activeTag,
  });

  if (profile === 'desktop') {
    report.add(
      'B1',
      doc.sidebarWidth > 100 && doc.sidebarLeft !== null && doc.contentLeft !== null && doc.sidebarLeft < doc.contentLeft && doc.treeDocCount > 0,
      `文章页侧边栏：宽=${doc.sidebarWidth} left=${doc.sidebarLeft} < 内容 left=${doc.contentLeft}、树节点=${doc.treeDocCount}`,
      { docSidebarWidth: doc.sidebarWidth, docTreeDocs: doc.treeDocCount },
    );
    report.add(
      'B2',
      doc.currentCount === 1 &&
        doc.currentPath === tourDoc.path &&
        doc.ancestorsOpen.length > 0 &&
        doc.ancestorsOpen.every(Boolean) &&
        doc.currentVisible,
      `aria-current 唯一=${doc.currentCount}、当前=${doc.currentPath}、祖先 details 全开=${js(doc.ancestorsOpen)}、在可视区=${doc.currentVisible}`,
      { b2CurrentPath: doc.currentPath, b2Ancestors: doc.ancestorsOpen },
    );
    report.add(
      'C5',
      doc.sidebarExists && (await br.eval(`!!document.querySelector('aside.sidebar nav[aria-label]')`, { retry: 1 })),
      '侧边栏存在 nav[aria-label]',
    );
  } else {
    report.skip('B1', '桌面专用断言（移动端由 B4/B5 覆盖）');
    report.skip('B2', '桌面专用断言（移动端由 B5 抽屉高亮覆盖）');
    report.add(
      'B4',
      doc.sidebarDisplay === 'none' && doc.drawerBtnVisible,
      `移动端文章页：侧边栏 display=${doc.sidebarDisplay}、目录按钮可见=${doc.drawerBtnVisible}`,
      { mobileDocSidebarDisplay: doc.sidebarDisplay, mobileDocDrawerBtn: doc.drawerBtnVisible },
    );
    report.add(
      'C5',
      doc.sidebarExists && (await br.eval(`!!document.querySelector('aside.sidebar nav[aria-label]')`, { retry: 1 })),
      '侧边栏存在 nav[aria-label]（移动端隐藏但仍在 DOM）',
    );
  }

  /* 记录锚点：深链阶段用 */
  ctx.anchorId = await br.eval(`(() => { const heading = document.querySelector('.page-content h2[id], .doc-page h2[id], .markdown-body h2[id]'); return heading ? heading.id : null; })()`, { retry: 1 });

  /* --- wikilink 导航 --- */
  const wikilink = await br.eval(
    `(() => { const link = document.querySelector('.page-content a.wikilink, .doc-page a.wikilink, .markdown-body a.wikilink'); return link ? { target: link.getAttribute('data-target') } : null; })()`,
    { retry: 1 },
  );
  if (wikilink) {
    await navActive(br, true);
    await clickJs(br, `document.querySelector('.page-content a.wikilink, .doc-page a.wikilink, .markdown-body a.wikilink')`, '文章内 wikilink');
    await br.waitFor(`location.pathname !== ${js(docUrl(tourDoc.path))}`, { label: 'wikilink 导航', timeout: 15000 });
    const wikilinkPath = await br.eval('location.pathname', { retry: 1 });
    await waitPage(br, wikilinkPath, { settle: 500, label: 'wikilink 目标页' });
    await navActive(br, false);
    const wiki = await measure(br);
    report.add('A2', identityOk(wiki), `wikilink 导航后：${identityDetail(wiki)}`);
    report.add('A4', contentOk(wiki), `wikilink 导航后：${contentDetail(wiki)}`);
  } else {
    report.add('A2', false, '文章内没有找到 a.wikilink，无法验证 wikilink 导航');
    report.add('A4', false, '文章内没有找到 a.wikilink，无法验证 wikilink 导航');
  }

  /* --- 搜索（顶栏搜索按钮，回车等价） --- */
  const preservedQuery = await br.eval(`(document.querySelector('.search-input') || {}).value ?? null`, { retry: 1 });
  if (preservedQuery !== '压感') {
    // 旧构建会在导航时重建顶栏、清空搜索框（A3 已因此失败）；补写一次，让后续条款还能继续验证。
    await br.eval(
      `(() => { const input = document.querySelector('.search-input'); if (!input) return false; input.value = ${js('压感')}; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`,
      { retry: 0 },
    );
  }
  await navActive(br, true);
  await br.click('.btn-search');
  await waitPage(br, '/search', { marker: '.search-page', settle: 500, label: '搜索页' });
  await navActive(br, false);
  const search = await measure(br);
  report.add(
    'A3',
    search.search === `?q=${encodeURIComponent('压感')}` && search.searchValue === '压感',
    `搜索页 URL=${search.path}${search.search}、搜索框值=${js(search.searchValue)}`,
    { searchQuery: search.search, searchPageValue: search.searchValue },
  );
  report.add('A2', identityOk(search), `搜索页：${identityDetail(search)}`);
  report.add('A4', contentOk(search), `搜索页：${contentDetail(search)}`);
  report.add('A6', search.title.includes('搜索'), `搜索页 title=${search.title}`, { searchTitle: search.title });
  report.add('C5', search.activeInContent, `搜索页焦点在内容区=${search.activeInContent}（${search.activeTag}）`);
  if (profile === 'desktop') {
    report.add(
      'B4',
      search.sidebarWidth > 100 && search.treeDocCount > 0,
      `桌面搜索页侧边栏：宽=${search.sidebarWidth} 树节点=${search.treeDocCount}`,
      { searchSidebarWidth: search.sidebarWidth },
    );
  }

  /* --- 报告页 --- */
  await navActive(br, true);
  await clickJs(br, navLinkExpr('/reports'), '顶栏「报告」');
  await waitPage(br, '/reports', { marker: '.reports-page', settle: 600, label: '报告页' });
  await navActive(br, false);
  const reports = await measure(br);
  report.add('A2', identityOk(reports), `报告页：${identityDetail(reports)}`);
  report.add('A4', contentOk(reports), `报告页：${contentDetail(reports)}`);
  report.add('A6', reports.title.includes('报告'), `报告页 title=${reports.title}`, { reportsTitle: reports.title });
  report.add('C5', reports.activeInContent, `报告页焦点在内容区=${reports.activeInContent}（${reports.activeTag}）`);
  if (profile === 'desktop') {
    report.add('B4', reports.sidebarWidth > 100 && reports.treeDocCount > 0, `桌面报告页侧边栏：宽=${reports.sidebarWidth}`);
  }

  /* --- 报告页 → 首页（点品牌） --- */
  await navActive(br, true);
  await clickJs(br, `document.querySelector('.brand')`, '顶栏品牌回首页');
  await waitPage(br, '/', { marker: '.main-column', title: '私有知识库', label: '回首页' });
  await navActive(br, false);
  const homeAgain = await measure(br);
  report.add('A2', identityOk(homeAgain), `回首页后：${identityDetail(homeAgain)}`);
  report.add('A4', contentOk(homeAgain), `回首页后：${contentDetail(homeAgain)}`);

  /* --- 滚动恢复（A5）：push 回顶 / back 恢复 / forward 恢复 --- */
  try {
    await br.eval('window.scrollTo(0, 400); true', { retry: 0 });
  await br.settle(150);
  const homeScroll = await br.eval('window.scrollY', { retry: 1 });
  await navActive(br, true);
  await clickJs(br, docLinkExpr(scrollDoc.path), `首页长文链接 ${scrollDoc.path}`);
  await waitPage(br, docUrl(scrollDoc.path), { marker: '.doc-page', title: scrollDoc.title, label: '滚动测试进入长文' });
  await navActive(br, false);
  const pushScroll = await br.eval('window.scrollY', { retry: 1 });
  await br.eval('window.scrollTo(0, 300); true', { retry: 0 });
  await br.settle(150);
  const docScroll = await br.eval('window.scrollY', { retry: 1 });

  await navActive(br, true);
  await br.back();
  await br.waitFor(`location.pathname === '/'`, { label: '后退回首页', timeout: 15000 });
  await br.settle(600);
  await navActive(br, false);
  const backScroll = await br.eval('window.scrollY', { retry: 1 });
  const backMeasure = await measure(br);

  await navActive(br, true);
  await br.forward();
  await br.waitFor(`location.pathname === ${js(docUrl(scrollDoc.path))}`, { label: '前进回长文', timeout: 15000 });
  await br.settle(600);
  await navActive(br, false);
  const forwardScroll = await br.eval('window.scrollY', { retry: 1 });
  const forwardMeasure = await measure(br);

  report.add('A2', identityOk(backMeasure) && identityOk(forwardMeasure), `后退/前进后：${identityDetail(forwardMeasure)}`);
  report.add('A4', contentOk(backMeasure) && contentOk(forwardMeasure), `后退/前进后：${contentDetail(forwardMeasure)}`);
  report.add(
    'A5',
    Math.abs(pushScroll) <= 1 && Math.abs(backScroll - homeScroll) <= 2 && Math.abs(forwardScroll - docScroll) <= 2,
    `push scrollY=${pushScroll}(期望0)；后退=${backScroll}(记录 ${homeScroll})；前进=${forwardScroll}(记录 ${docScroll})`,
    { pushScroll, homeScroll, backScroll, docScroll, forwardScroll },
  );
  } catch (error) {
    report.add('A5', false, `滚动恢复步骤失败：${short(error)}`);
  }

  /* --- B3：侧边栏身份 / scrollTop / /api/tree 次数（仅桌面） --- */
  if (profile === 'desktop') {
    try {
      const beforeTreeCount = (await br.requests()).filter((request) => (request.url || '').includes('/api/tree')).length;
      const before = await br.eval(
        `(() => {
          const aside = document.querySelector('aside.sidebar');
          if (!aside) return null;
          aside.scrollTop = Math.min(120, Math.max(0, aside.scrollHeight - aside.clientHeight));
          return { identity: aside === (window.__e2eRefs || {}).sidebar, scrollTop: aside.scrollTop };
        })()`,
        { retry: 1 },
      );
      await navActive(br, true);
      await clickJs(br, treeLinkExpr(secondDoc.path), `侧边栏第二篇文档 ${secondDoc.path}`);
      await waitPage(br, docUrl(secondDoc.path), { marker: '.doc-page', title: secondDoc.title, label: '侧边栏切换文档' });
      await navActive(br, false);
      const after = await measure(br);
      const treeRequests = (await br.requests()).filter((request) => (request.url || '').includes('/api/tree')).length - beforeTreeCount;
      report.add(
        'B3',
        Boolean(before && before.identity) && after.sidebarSame && (before.scrollTop === 0 || after.sidebarScrollTop > 0) && treeRequests <= 1,
        `侧边栏引用不变=${after.sidebarSame}、scrollTop ${before && before.scrollTop}→${after.sidebarScrollTop}、本次导航 /api/tree=${treeRequests} 次`,
        { b3ScrollTopBefore: before && before.scrollTop, b3ScrollTopAfter: after.sidebarScrollTop, b3TreeRequests: treeRequests },
      );
    } catch (error) {
      report.add('B3', false, `B3 步骤失败：${short(error)}`);
    }
  } else {
    report.skip('B3', '桌面专用断言（移动端侧边栏隐藏）');
  }

  /* --- A1 收尾：整轮巡览后 navigation 条目仍为 1 --- */
  const finalMeasure = await measure(br);
  report.add(
    'A1',
    finalMeasure.navCount === ctx.boot.navCount &&
      finalMeasure.timeOrigin === ctx.boot.timeOrigin &&
      (ctx.boot.bootAt === null || finalMeasure.bootAt === ctx.boot.bootAt),
    `巡览后 navigation 条目=${finalMeasure.navCount}（启动 ${ctx.boot.navCount}）、timeOrigin 不变=${finalMeasure.timeOrigin === ctx.boot.timeOrigin}、__kbBootAt=${js(ctx.boot.bootAt)}→${js(finalMeasure.bootAt)}`,
    { finalNavCount: finalMeasure.navCount, timeOriginStable: finalMeasure.timeOrigin === ctx.boot.timeOrigin },
  );
}

async function phaseDrawer(br, ctx) {
  const { report, profile } = ctx;
  if (profile !== 'mobile') {
    report.skip('B5', '抽屉仅在移动端（≤860px）可见；桌面侧边栏常驻');
    return;
  }
  const drawerStartPath = await br.eval('location.pathname', { retry: 1 });
  if (drawerStartPath !== '/') {
    await navActive(br, true);
    await clickJs(br, `document.querySelector('.brand')`, '顶栏品牌回首页（抽屉阶段）');
    await waitPage(br, '/', { marker: '.main-column', title: '私有知识库', label: '抽屉阶段首页' });
    await navActive(br, false);
  } else {
    await waitPage(br, '/', { marker: '.main-column', title: '私有知识库', label: '抽屉阶段首页' });
  }
  const trigger = await br.eval(
    `(() => { const btn = document.querySelector('.nav-tree-btn'); return btn ? { visible: btn.getBoundingClientRect().width > 0 } : null; })()`,
    { retry: 1 },
  );
  if (!trigger || !trigger.visible) {
    report.add('B5', false, '顶栏「☰ 目录」按钮不存在或不可见，无法打开抽屉');
    return;
  }

  await br.click('.nav-tree-btn');
  await br.waitFor(`!!document.querySelector('.tree-drawer')`, { label: '抽屉打开' });
  await br.settle(150);
  const opened = await measure(br);
  report.add(
    'B5',
    opened.drawer && opened.drawerRole === 'dialog' && opened.drawerAriaModal === 'true' && opened.noScroll && opened.activeInDrawer && opened.drawerTreeDocs > 0,
    `打开：drawer=${opened.drawer} role=${opened.drawerRole} aria-modal=${opened.drawerAriaModal} no-scroll=${opened.noScroll} 焦点在抽屉内=${opened.activeInDrawer} 树节点=${opened.drawerTreeDocs}`,
    { drawerTreeDocs: opened.drawerTreeDocs },
  );
  report.add(
    'B4',
    opened.drawerCurrentCount === 1,
    `抽屉内当前文档高亮个数=${opened.drawerCurrentCount}（期望 1）`,
    { drawerCurrentCount: opened.drawerCurrentCount },
  );

  /* Esc 关闭 */
  await br.press('Escape');
  await br.settle(200);
  const afterEsc = await br.eval(
    `(() => ({ drawer: !!document.querySelector('.tree-drawer'), noScroll: document.documentElement.classList.contains('no-scroll'), focusOnTrigger: document.activeElement === document.querySelector('.nav-tree-btn'), focusTag: document.activeElement ? document.activeElement.tagName : null }))()`,
    { retry: 1 },
  );
  report.add('B5', !afterEsc.drawer && !afterEsc.noScroll && afterEsc.focusOnTrigger, `Esc 关闭：drawer=${afterEsc.drawer} no-scroll=${afterEsc.noScroll} 焦点回触发按钮=${afterEsc.focusOnTrigger}（${afterEsc.focusTag}）`);

  /* 遮罩关闭 */
  await br.click('.nav-tree-btn');
  await br.waitFor(`!!document.querySelector('.tree-drawer')`, { label: '抽屉重新打开' });
  await br.settle(120);
  await br.eval(`(() => { const overlay = document.querySelector('.tree-drawer-overlay'); if (overlay) overlay.click(); return true; })()`, { retry: 0 });
  await br.settle(200);
  const afterOverlay = await br.eval(`(() => ({ drawer: !!document.querySelector('.tree-drawer'), noScroll: document.documentElement.classList.contains('no-scroll') }))()`, { retry: 1 });
  report.add('B5', !afterOverlay.drawer && !afterOverlay.noScroll, `点遮罩关闭：drawer=${afterOverlay.drawer} no-scroll=${afterOverlay.noScroll}`);

  /* 点抽屉里的链接导航后关闭 */
  const currentPath = afterOverlay && (await br.eval('location.pathname', { retry: 1 }));
  await br.click('.nav-tree-btn');
  await br.waitFor(`!!document.querySelector('.tree-drawer')`, { label: '抽屉第三次打开' });
  await br.settle(120);
  await navActive(br, true);
  const clicked = await br.eval(
    `(() => { const drawer = document.querySelector('.tree-drawer'); if (!drawer) return { ok: false }; const link = [...drawer.querySelectorAll('a.tree-doc')].find((node) => node.dataset.docPath && ${js(docUrl(currentPath))} !== node.getAttribute('href')); if (!link) return { ok: false }; const href = link.getAttribute('href'); link.click(); return { ok: true, href }; })()`,
    { retry: 0 },
  );
  if (clicked && clicked.ok) {
    await br.waitFor(`location.pathname !== ${js(currentPath)}`, { label: '抽屉内链接导航', timeout: 15000 });
    await br.settle(700);
    await navActive(br, false);
    const afterLink = await br.eval(
      `(() => ({ drawer: !!document.querySelector('.tree-drawer'), noScroll: document.documentElement.classList.contains('no-scroll'), path: location.pathname }))()`,
      { retry: 1 },
    );
    report.add('B5', !afterLink.drawer && !afterLink.noScroll, `点抽屉链接导航到 ${afterLink.path} 后自动关闭：drawer=${afterLink.drawer} no-scroll=${afterLink.noScroll}`);
  } else {
    report.add('B5', false, '抽屉里没有可点击的文档链接');
  }

  /* 焦点陷阱（Tab 不逃出抽屉） */
  await br.click('.nav-tree-btn');
  await br.waitFor(`!!document.querySelector('.tree-drawer')`, { label: '抽屉第四次打开' });
  await br.settle(120);
  for (let i = 0; i < 4; i += 1) await br.press('Tab');
  const trapped = await br.eval(`(() => { const drawer = document.querySelector('.tree-drawer'); return { inDrawer: !!(drawer && document.activeElement && drawer.contains(document.activeElement)) }; })()`, { retry: 1 });
  report.add('C5', trapped.inDrawer, `抽屉内 Tab×4 后焦点仍在抽屉内=${trapped.inDrawer}`);
  await br.press('Escape');
  await br.settle(150);
}

async function phaseTreeFailure(br, ctx) {
  const { report, fixture, base } = ctx;
  try {
    br.routeAbort('**/api/tree*');
  } catch (error) {
    report.skip('B7', `agent-browser network route 不可用：${short(error)}`);
    return;
  }
  try {
    await br.open(`${base}${docUrl(fixture.tourDoc.path)}`);
    await br.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`, { label: 'B7 页面加载', timeout: 25000 });
    await br.settle(900);
    const failed = await measure(br);
    report.add(
      'B7',
      failed.sidebarError && failed.sidebarErrorRetry && failed.contentChildren > 0 && !failed.bootLoading,
      `树失败时：侧边栏错误=${failed.sidebarError} 重试按钮=${failed.sidebarErrorRetry} 正文子节点=${failed.contentChildren} 整页 spinner=${failed.bootLoading}`,
      { b7SidebarError: failed.sidebarError, b7ContentChildren: failed.contentChildren },
    );
    if (!failed.sidebarErrorRetry) return;

    br.unroute();
    await clickJs(br, `document.querySelector('.sidebar-error button')`, '侧边栏重试');
    await br.waitFor(`document.querySelectorAll('aside.sidebar a.tree-doc').length > 0`, { label: '侧边栏重试后树恢复', timeout: 20000 });
    await br.settle(300);
    const recovered = await measure(br);
    report.add(
      'B7',
      recovered.treeDocCount > 0 && recovered.contentChildren > 0,
      `重试后：侧边栏树节点=${recovered.treeDocCount}、正文子节点=${recovered.contentChildren}`,
      { b7RecoveredTreeDocs: recovered.treeDocCount },
    );
  } finally {
    br.unroute();
  }
}

async function phaseDeepLink(br, ctx) {
  const { report, fixture, base } = ctx;
  if (!ctx.anchorId) {
    report.skip('A5', '文章中没有带 id 的标题，无法验证 #hash 深链');
    return;
  }
  const url = `${base}${docUrl(fixture.scrollDoc.path)}#${ctx.anchorId}`;
  await br.open(url);
  await br.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`, { label: '深链页面加载', timeout: 25000 });
  await br.settle(800);
  const hashed = await br.eval(
    `(() => { const target = document.getElementById(${js(ctx.anchorId)}); return { path: location.pathname, hash: location.hash, scrollY: window.scrollY, rectTop: target ? Math.round(target.getBoundingClientRect().top) : null, contentChildren: (document.querySelector('.page-content') || { childElementCount: -1 }).childElementCount }; })()`,
    { retry: 1 },
  );
  report.add(
    'A5',
    Boolean(hashed) && hashed.hash === `#${ctx.anchorId}` && hashed.rectTop !== null && Math.abs(hashed.rectTop) <= 8,
    `深链 ${hashed && hashed.hash}：锚点 rect.top=${hashed && hashed.rectTop}（期望≈0）、scrollY=${hashed && hashed.scrollY}`,
    { hashScrollY: hashed && hashed.scrollY, hashRectTop: hashed && hashed.rectTop },
  );
}

async function phaseEdit(br, ctx) {
  const { report, fixture, base, profile } = ctx;
  await br.open(`${base}${editUrl(fixture.tourDoc.path)}`);
  await br.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`, { label: '编辑页加载', timeout: 25000 });
  await br.settle(900);
  const edit = await measure(br);
  if (profile === 'desktop') {
    report.add(
      'B4',
      edit.sidebarDisplay === 'none' && edit.shellWide,
      `编辑页（桌面）：侧边栏 display=${edit.sidebarDisplay}、宽版 shell=${edit.shellWide}、正文子节点=${edit.contentChildren}`,
      { editSidebarDisplay: edit.sidebarDisplay, editShellWide: edit.shellWide },
    );
  } else {
    report.add(
      'B4',
      edit.sidebarDisplay === 'none' && !edit.drawerBtnVisible,
      `编辑页（移动端）：侧边栏 display=${edit.sidebarDisplay}、目录按钮可见=${edit.drawerBtnVisible}（契约：编辑页不给抽屉按钮）`,
      { editDrawerBtnVisible: edit.drawerBtnVisible },
    );
  }
}

async function phaseNotFound(br, ctx) {
  const { report, base } = ctx;
  await br.open(`${base}/no-such-page`);
  await br.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`, { label: '未知路由页面加载', timeout: 25000 });
  await br.settle(500);
  const notfound = await measure(br);
  report.add(
    'A6',
    notfound.shell && notfound.topbar && notfound.sidebarExists && notfound.searchInput && notfound.contentText.includes('页面不存在'),
    `未知路由：shell=${notfound.shell} topbar=${notfound.topbar} 侧边栏=${notfound.sidebarExists} 搜索框=${notfound.searchInput} 文案含「页面不存在」=${notfound.contentText.includes('页面不存在')}`,
    { notfoundText: notfound.contentText.slice(0, 80) },
  );
  report.add(
    'B6',
    notfound.shell && notfound.sidebarExists && notfound.contentChildren > 0 && !notfound.bootLoading,
    `未知路由留在 shell 内：shell=${notfound.shell} 侧边栏=${notfound.sidebarExists} 内容子节点=${notfound.contentChildren}`,
    { notfoundContentChildren: notfound.contentChildren },
  );

  await br.open(`${base}${docUrl('__e2e_missing_doc__')}`);
  await br.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`, { label: '缺失文档页面加载', timeout: 25000 });
  await br.settle(900);
  const missing = await measure(br);
  report.add(
    'B6',
    missing.shell && missing.sidebarExists && missing.contentChildren > 0 && !missing.bootLoading && /不存在|没有这篇|加载失败/.test(missing.contentText),
    `缺失文档：shell=${missing.shell} 侧边栏=${missing.sidebarExists} 内容子节点=${missing.contentChildren} 文案=${js(missing.contentText.slice(0, 60))}`,
    { missingDocText: missing.contentText.slice(0, 80) },
  );
}

function isExpectedFailure(request) {
  const url = request.url || '';
  if (url.includes('__e2e_missing')) return true; // 刻意访问不存在的笔记
  if (url.includes('/api/tree')) return true; // B7 刻意 abort
  return false;
}

async function phaseAudit(br, ctx) {
  const { report, errors } = ctx;
  const snapshot = await readCollector(br);
  mergeErrors(errors, snapshot, 'final');
  const requests = await br.requests();
  const unexpected = requests
    .filter((request) => typeof request.status === 'number' && request.status >= 400 && !isExpectedFailure(request))
    .map((request) => `${request.status} ${request.method || 'GET'} ${request.url}`);
  const consoleCount = errors.consoleErrors.length;
  const pageErrorCount = errors.pageErrors.length;
  const rejectionCount = errors.rejections.length;
  const ok = consoleCount === 0 && pageErrorCount === 0 && rejectionCount === 0 && unexpected.length === 0;
  report.add(
    'C4',
    ok,
    `console.error=${consoleCount}、pageerror=${pageErrorCount}、unhandledrejection=${rejectionCount}、非预期 4xx/5xx=${unexpected.length}`,
    {
      consoleErrors: errors.consoleErrors.slice(0, 10),
      pageErrors: errors.pageErrors.slice(0, 10),
      rejections: errors.rejections.slice(0, 10),
      unexpectedNetwork: unexpected.slice(0, 10),
    },
  );
}

/* ------------------------------------------------------------------ */
/* 单个 profile 的运行器                                               */
/* ------------------------------------------------------------------ */

async function runProfile(profile, options, fixture) {
  const viewport = PROFILES[profile];
  const session = `${options.sessionPrefix}-${profile}`;
  const br = new Browser(session, { verbose: options.verbose });
  const report = new Recorder(profile);
  const errors = { consoleErrors: [], pageErrors: [], rejections: [] };
  const ctx = { report, errors, profile, fixture, base: options.base, boot: null, anchorId: null };
  const startedAt = new Date();
  const phases = [];

  const runPhase = async (name, ids, fn) => {
    const phaseStart = Date.now();
    try {
      await fn();
      phases.push({ name, ok: true, ms: Date.now() - phaseStart });
    } catch (error) {
      phases.push({ name, ok: false, ms: Date.now() - phaseStart, error: short(error) });
      for (const id of ids) {
        if (!report.has(id)) report.add(id, false, `${name} 阶段失败：${short(error)}`);
      }
    } finally {
      const snapshot = await readCollector(br).catch(() => null);
      mergeErrors(errors, snapshot, name);
      try {
        br.settle(60);
      } catch {
        /* ignore */
      }
    }
  };

  try {
    br.close();
    br.setViewport(viewport.width, viewport.height);
    await br.open(`${options.base}/`);
    await br.waitFor(`!!document.querySelector('.topbar') && !document.querySelector('.boot-loading')`, { label: '首屏加载', timeout: 25000 });
    await br.settle(300);

    await runPhase('tour', ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'C5'], () => phaseTour(br, ctx));
    await runPhase('drawer', ['B4', 'B5', 'C5'], () => phaseDrawer(br, ctx));
    await runPhase('tree-failure', ['B7'], () => phaseTreeFailure(br, ctx));
    await runPhase('deep-link', ['A5'], () => phaseDeepLink(br, ctx));
    await runPhase('edit', ['B4'], () => phaseEdit(br, ctx));
    await runPhase('not-found', ['A6', 'B6'], () => phaseNotFound(br, ctx));
    await runPhase('audit', ['C4'], () => phaseAudit(br, ctx));
  } catch (error) {
    phases.push({ name: 'fatal', ok: false, error: short(error) });
    for (const id of ORDER) report.add(id, false, `profile 运行失败：${short(error)}`);
  } finally {
    br.close();
  }

  report.finalize(ORDER);
  const assertions = report.list();
  const summary = {
    pass: assertions.filter((item) => item.status === 'pass').length,
    fail: assertions.filter((item) => item.status === 'fail').length,
    skip: assertions.filter((item) => item.status === 'skip').length,
  };
  return {
    profile,
    viewport: `${viewport.width}x${viewport.height}`,
    session,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    phases,
    assertions,
    summary,
    errors,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.sessionPrefix = `kbux-e2e-${process.pid}`;
  const profiles = options.profile === 'both' ? ['desktop', 'mobile'] : [options.profile];
  const result = {
    generatedAt: new Date().toISOString(),
    base: options.base,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    agentBrowser: null,
    criteria: CRITERIA,
    build: null,
    fixture: null,
    profiles: {},
    summary: { pass: 0, fail: 0, skip: 0, ok: false },
  };

  let fatal = null;
  try {
    const version = spawnSync('agent-browser', ['--version'], { shell: IS_WIN, encoding: 'utf8', timeout: 20000 });
    result.agentBrowser = (version.stdout || '').trim() || null;
    if (version.status !== 0) throw new Error(`agent-browser --version 失败：${short(version.stderr || version.stdout)}，请先安装 agent-browser`);

    result.build = await collectBuildInfo(options.base);
    if (result.build.healthStatus !== 200) throw new Error(`/api/health 不可用（HTTP ${result.build.healthStatus}）：确认 wrangler dev 正在 ${options.base} 上运行`);
    const tree = await fetchTree(options.base);
    result.fixture = await buildFixture(tree, options.base);
    result.build.docs = tree.length;

    for (const profile of profiles) {
      console.log(`\n== ${profile} ${PROFILES[profile].width}x${PROFILES[profile].height} ==`);
      const profileResult = await runProfile(profile, options, result.fixture);
      result.profiles[profile] = profileResult;
      result.summary.pass += profileResult.summary.pass;
      result.summary.fail += profileResult.summary.fail;
      result.summary.skip += profileResult.summary.skip;
      for (const assertion of profileResult.assertions) {
        const mark = assertion.status === 'pass' ? 'PASS' : assertion.status === 'fail' ? 'FAIL' : 'SKIP';
        console.log(`  [${mark}] ${assertion.id.padEnd(2)} ${assertion.details.join(' | ')}`);
      }
      console.log(`  → ${profileResult.summary.pass} pass / ${profileResult.summary.fail} fail / ${profileResult.summary.skip} skip（${(profileResult.durationMs / 1000).toFixed(1)}s）`);
    }
  } catch (error) {
    fatal = short(error);
    console.error(`\n[错误] ${fatal}`);
  }

  result.summary.ok = fatal === null && result.summary.fail === 0;
  result.fatal = fatal;

  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`\n报告：${options.out}`);
  console.log(`总计：${result.summary.pass} pass / ${result.summary.fail} fail / ${result.summary.skip} skip → ${result.summary.ok ? 'OK' : 'FAILED'}`);
  if (fatal) console.log(`失败原因：${fatal}`);
  process.exit(result.summary.ok ? 0 : 1);
}

main().catch((error) => {
  console.error(`[致命错误] ${short(error)}`);
  process.exit(1);
});
