# 端到端导航 / 侧边栏验收（nav-check）

`nav-check.mjs` 用 [`agent-browser`](https://www.npmjs.com/package/agent-browser) CLI 驱动一个**独立浏览器会话**，
机器断言 `docs/web-nav-sidebar-acceptance.md` §4 的 **A1-A6 / B1-B8 / C4 / C5**，输出 PASS/FAIL 明细 + JSON 报告。

**不使用截图判断**：所有结论都来自 `agent-browser eval` 返回的 DOM / 几何（`getBoundingClientRect`）/
`performance` / `history.state` 数据，便于在无图像输入的 agent 环境里复跑。

## 前置条件

1. **一个跑着真实数据的站点**（二选一）
   - 本地 Worker：`pnpm dev` → `http://127.0.0.1:8787`（本机 D1，含真实笔记）
   - 构建产物预览：`pnpm build` 后 `pnpm --dir web preview` → `http://127.0.0.1:4173`
   - Vite dev（HMR，验证实现而非产物）：`VITE_DEV_PROXY_TARGET=http://127.0.0.1:8787 pnpm --dir web dev` → `http://127.0.0.1:5173`

   > 验收记录请用**构建产物**（8787 或 4173）跑：
   > `VITE_DEV_PROXY_TARGET` 的 dev server 与 `pnpm build` 的 bundle 走不同代码路径
   > （例如 `import.meta.env.DEV` 分支），只跑 dev 不能替代产物验收。

2. **agent-browser 已安装**

   ```bash
   npm i -g agent-browser && agent-browser install
   agent-browser --version   # 本仓库验收时用 0.41.0
   ```

3. **笔记语料 ≥ 2 篇且不要太少**：脚本从 `/api/tree` 里自动挑「最大的、且含 wikilink 的文档」
   作巡览目标，并自动发现「目录 + 同名笔记」碰撞（B8）。语料为空会直接报错退出。

## 用法

```bash
# 双端（桌面 1280x900 + 移动 390x844），默认写 web/e2e/reports/last.json
node web/e2e/nav-check.mjs

# 指定站点与输出（推荐：验收证据落到 docs/evidence/）
node web/e2e/nav-check.mjs --base http://127.0.0.1:8787 --out docs/evidence/after-nav-check.json

# 只跑一端
node web/e2e/nav-check.mjs --base http://127.0.0.1:4173 --profile mobile

# 排查：打印每条 agent-browser 命令与退出码
node web/e2e/nav-check.mjs --base http://127.0.0.1:4173 --verbose
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--base <url>` | `$NAV_CHECK_BASE` 或 `http://127.0.0.1:8787` | 被测站点根地址（末尾 `/` 自动去掉） |
| `--out <json>` | `web/e2e/reports/last.json` | 报告路径（相对当前目录），目录会自动创建 |
| `--profile <p>` | `both` | `desktop` / `mobile` / `both` |
| `--timeout <ms>` | `20000` | 单条等待的超时 |
| `--verbose` | 关 | 打印 agent-browser 命令与退出码 |

**退出码**：`0` = 所有机器断言通过（skip 不算失败）；`1` = 有 fail、或脚本自身/环境出错（报告里 `fatal` 字段写明原因）。

### PowerShell 注意

- `@ref` 必须加引号：`agent-browser click "@e12"`（`@` 在 PowerShell 里是数组/哈希字面量起始符）。
- 本脚本内部用 `spawnSync(..., { shell: true })` 调用 CLI 并自行加引号，**不需要**手工转义；
  它通过 `--init-script` 注入观测器、通过 `eval --stdin` 传多行 JS（避免 shell 引号地狱）。
- 脚本自己生成会话名 `kbux-e2e-<pid>-<profile>`，不会碰你在用的默认会话；
  跑完会 `close` 掉自己的会话。

## 断言地图

| 条款 | 阶段 | 机器判据（摘要） |
|---|---|---|
| A1 | tour | `performance.getEntriesByType('navigation').length === 1`；`timeOrigin` 前后不变；`window.__kbBootAt`（应用在 `mount()` 前写入的**数字**）两侧都是 number 且严格相等——探针缺失/非数字即判红，不允许「null === null」式假绿 |
| A2 | tour | `.app-shell` / `.topbar` / `aside.sidebar` 引用相等；`MutationObserver` 没记录到被移除；整页 spinner 出现 0 次（判据：`.state-loading`/`.boot-loading` 作为 `#app` 直接子级、或落在 `.page-content` 之外） |
| A3 | tour | 首页输入「压感」→ 文章页输入框值仍是「压感」且焦点不在 input；搜索页 URL 带 `?q=` 且回填 |
| A4 | tour | `.page-content` 有子节点、导航中空采样 0 次、`aria-busy` 加载中为 true、完成后清除 |
| A5 | tour + deep-link | push 后 `scrollY=0`；back 恢复离页位置（±2）；forward 恢复进入位置（±2）；`#hash` 深链锚点 `rect.top ∈ [-8, 120]` |
| A6 | tour + not-found | `document.title` 随路由变化；`/no-such-page` 在 shell 内渲染「页面不存在」（保留侧边栏与搜索框） |
| B1 | tour（桌面） | `/d/` 页 `aside.sidebar` 宽 > 100、左边界在 `.page-content` 左侧、树节点 > 0 |
| B2 | tour（桌面） | `.tree-doc[aria-current=page]` 唯一且等于当前路径；祖先目录行已展开、当前项在侧边栏可视区 |
| B3 | tour（桌面） | 侧边栏 DOM 引用不变、`scrollTop` 不被清零、本次导航 `/api/tree` ≤ 1 次 |
| B4 | tour / drawer / edit | `/`、`/search`、`/reports` 有侧边栏；`/edit/` 无侧边栏且宽版；移动端侧边栏 `display:none`、「☰ 目录」可见；抽屉内当前文档高亮 1 个；编辑页无目录按钮 |
| B5 | drawer（移动） | 抽屉 `role=dialog` + `aria-modal=true`；Esc / 点遮罩 / 点链接都关闭；焦点回触发按钮；无残留 `no-scroll` |
| B6 | not-found | 404 与「笔记不存在」都在 shell 内、保留侧边栏、无整页 spinner |
| B7 | tree-failure | 用 `network route **/api/tree* --abort` 打断树请求：侧边栏出现可重试错误、正文仍可用；`unroute` 后点重试恢复 |
| B8 | tour | 「目录 + 同名笔记」只出现一行 `.tree-dir-row[data-dir-path]`，行内同时有 `a.tree-doc` 与 `.tree-dir-toggle`（`aria-expanded` / `aria-controls` 指向的子树可见性一致） |
| C4 | audit | 全程 `console.error` / `pageerror` / `unhandledrejection` 为 0；无**非预期** 4xx/5xx |
| C5 | tour / drawer | 导航后焦点落在 `.page-content` 内；侧边栏有 `nav[aria-label]`；抽屉内 Tab 不逃出（焦点陷阱） |

### C4 的「预期失败」白名单

脚本只豁免三类**由测试主动制造**的失败，其余 4xx/5xx 一律算 C4 失败：

1. `/api/docs/__e2e_missing_doc__` —— 刻意访问不存在的笔记（验证 B6）；
2. `/api/tree` —— B7 刻意 abort；
3. 短名 wikilink 先请求 `/api/docs/<短名>` 得到 404，再由页面纠正地址栏（既有行为）。

`favicon.ico` **不在**白名单里：站点应自带 inline favicon，不再产生 404。

## 已知限制

- **必须真浏览器**：脚本用 `agent-browser`（Chromium/CDP）。没有 CDP 的环境（纯 CI）跑不了，所以 e2e **不进 GitHub CI**；
  CI 只跑 `pnpm test` + `pnpm --dir web test` + `pnpm build`。
- **视口设置顺序**：`agent-browser set viewport` 必须在 `open` 之后、且随后 `reload` 才生效
  （`open` 会 relaunch 浏览器并丢掉之前的视口覆盖）。脚本已内置这个顺序，并在进入 tour 前**硬校验**
  `window.innerWidth`，不匹配就以 fatal 报错——避免以前那种「移动端其实在 1258px 下跑」的假通过。
- **B7 依赖 `agent-browser network route`**：如果某个 agent-browser 版本不支持该子命令，B7 会记为 `skip`
  并在 detail 里写明原因（不会静默 pass）。
- **依赖真实语料特征**：wikilink 巡览、B8 合并行、`#hash` 深链都需要语料里有对应内容。
  缺 wikilink 时 A2/A4 的 wikilink 子断言记为 fail 并说明原因；没有「目录+同名笔记」时 B8 记 skip。
- **滚动断言**：`back`/`forward` 的恢复是异步的（等内容渲染完），脚本用轮询等待到目标值（容差 2px）后再判定，
  不是固定 sleep。
- **报告内容**：JSON 里只有 URL 路径、断言明细、DOM 摘要与错误文本，**不含** token/secret。
  路径来自本机真实笔记标题，仓库开源前请确认 `docs/evidence/` 是否适合提交（或只保留 `--out` 到本地）。

## 报告结构

```jsonc
{
  "generatedAt": "2026-11-14T12:34:56.000Z",
  "base": "http://127.0.0.1:8787",
  "node": "v24.x",
  "platform": "win32-x64",
  "agentBrowser": "agent-browser 0.41.0",
  "criteria": { "A1": "…", "B8": "…" },        // 条款 → 描述
  "build": { "asset": "index-XXXX.js", "health": { "ok": true, "docs": 36 } },
  "fixture": { "tourDoc": { "path": "…" }, "collisions": ["示例库", "…"] },
  "profiles": {
    "desktop": {
      "viewport": "1280x900",
      "phases": [{ "name": "tour", "ok": true, "ms": 12000 }],
      "assertions": [
        { "id": "A2", "status": "pass", "details": ["进入文章后：…"], "measured": { } }
      ],
      "summary": { "pass": 15, "fail": 0, "skip": 1 }
    },
    "mobile": { }
  },
  "summary": { "pass": 25, "fail": 0, "skip": 5, "ok": true },
  "fatal": null
}
```
