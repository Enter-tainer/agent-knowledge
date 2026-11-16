# 前端导航 / 侧边栏修复：设计契约、准出标准与验收记录

> 分支：`fix/web-spa-nav-sidebar`　目标：修掉「切换页面像整页刷新」和「文章页没有目录侧边栏」。
> 本文是**唯一契约**：实现、测试、对抗性审查都以本文为准。验收结果追加在 §7。
>
> **语料隐私**：本仓库是公开的，`vault-src/` 永不提交（见 `PUBLISHING.md`）。文中出现的
> vault 路径都是**合成/pseudonym 名**（`示例库/设备甲逆向/…`、`doc-NN`），结构（层级、同名冲突处数）
> 与真实语料一致，真实标题不进入 git；`node scripts/check-private.mjs` 必须退出码 0。

## 1. 问题（2026-11-14 基线实测，非猜测）

| # | 现象 | 根因（基线代码） | 证据 |
|---|---|---|---|
| P1 | 站内点链接「像整页刷新」：整块白屏 + spinner + 顶栏重画 + 页面滚回顶部 | `main.ts:61` 每次导航 `app.replaceChildren(bootLoading())` 把**整个 shell（顶栏+内容）**拆掉；`shell()` 每页重建；无滚动恢复 | MutationObserver 记录：导航时 `removed:app-shell` → `added:boot-loading` → 37ms 后 `added:app-shell`；`window.__spaMarker` 存活、`navigation` 计数=1（说明 JS 层是 SPA，但**观感与整页刷新一致**） |
| P2 | 文章页 `/d/<path>/` 没有目录侧边栏 | 侧边栏由 `pages/home.ts:27-37` 自己构造，只挂在家里；doc/search/reports 页没有 | 进入 doc 后 `document.querySelectorAll('.sidebar').length === 0` |
| P3 | 移动端只能从首页打开目录抽屉；文章页没有任何目录入口 | `openTreeDrawer` 只在 `home.ts` 内部使用 | 同 P2 |
| P4 | 每次导航都重新拉 `/api/tree` 之外的重复数据、文章页要等 doc+backlinks+links 三个请求都完成才首次出现内容 | `pages/doc.ts:36-74`：正文与反链/出链 `await Promise.all` 后才组装 DOM | 弱网下 spinner 停留时间 = 全部请求之和 |
| P5 | 目录里同名节点出现两行：一行能展开但「自己没内容」，另一行才是笔记 | vault 里存在同名「目录 + 笔记」（实测 4 处：`示例库`、`示例库/设备甲逆向`、`示例库/设备乙逆向`、`示例库/设备丙逆向`），`buildTree` 按路径分类时各出一行 | 用户 2026-11-14 追问「能展开的节点本身不能有内容吗？这设计是预期的吗？」；`/api/tree` 同时返回 `示例库` 与 `示例库/...` |

## 2. 目标架构（契约）

```
#app
└─ .app-shell                          ← 只在启动时挂载一次（持久）
   ├─ header.topbar                    ← 持久：品牌 / MOCK / 搜索框 / 导航 / 移动端「目录」按钮
   └─ .app-body  (data-sidebar=on|off)
      ├─ aside.sidebar                 ← 持久：目录树；只做「高亮/展开/滚动」增量更新
      └─ .page-content                 ← 唯一的替换点：#main 内容
```

**硬性约束**

1. `#app` 下的 `.app-shell`、`.topbar`、`aside.sidebar` 在整场会话中**DOM 节点身份不变**；导航只替换 `.page-content` 的子节点。
2. 首次加载之外，导航期间**不得**出现整页 spinner / 空白：旧内容保留到新内容就绪；用顶部 2px 进度条 + `aria-busy` 表达忙碌（>150ms 才显示，避免闪烁）。
3. 页面工厂返回 `PageView`（见 `web/src/ui/view.ts`），不再自己拼 `shell()`。
4. 侧边栏：桌面（>860px）常驻；移动端（≤860px）隐藏并在顶栏提供「☰ 目录」按钮打开抽屉。抽屉在 `kb:navigate` 后自动关闭、恢复焦点、解除 `no-scroll`。
5. 滚动：`history.scrollRestoration='manual'`；push 导航滚到顶；popstate（前进/后退）恢复该历史条目的 `scrollY`；带 `#hash` 的深链在渲染后滚到锚点。
6. 搜索框状态：顶栏搜索框的输入值在导航之间保留（搜索页由路由 `?q=` 回填）；不在导航时抢焦点。
7. 文章页渐进渲染：正文先出现，反链/出链面板随后填充（各自可独立失败，不阻塞正文）。
8. `/api/tree` 每场会话最多 1 次（走 `store.loadTree` 缓存）；保存成功后 `invalidateTree()` → 侧边栏刷新但保留展开状态与滚动位置。
9. 编辑页 `/edit/...` 保持宽版、**不显示**侧边栏（编辑器需要整宽），移动端也不给抽屉按钮；这是有意决策，写进 README。
10. **同名「目录 + 笔记」合并为一行**（P5 / B8）：`/root/test.md` + `/root/test/aaa.md` → 侧边栏只有一行 `test`：
    - 点名称 = 打开 `test.md`（`<a href="/d/test/">`，交 SPA 接管）；
    - 点行尾箭头 = 展开/收起 `test/` 下的子目录（`<button aria-expanded aria-controls>`）；
    - **点中间的「N 篇」徽标 = 同样展开/收起**（用户验收反馈，2026-11-15）：徽标也是 `<button>`，与箭头共用同一 `aria-controls` / `aria-expanded`，两侧状态互相同步；
    - 纯目录（没有同名笔记）仍用 `<details>/<summary>`，整行点击展开；箭头同样在右侧；
    - 合并只发生在树模型层（`ui/tree-model.ts`），后端 API 与文档 URL **不变**，总篇数不重复计数。
11. 页面不直接写 `document.title`：首次由 `PageView.title` 设置；页面内动态变更（如新建保存成功）走 `layout.setTitle()`。

**PageView 接口**（`web/src/ui/view.ts`，改动须同步本文）

```ts
export interface PageView {
  node: HTMLElement;            // 挂到 .page-content 的根节点
  active: ActiveNav;            // 顶栏高亮：'home'|'doc'|'search'|'reports'|'edit'
  title: string;                // document.title
  searchQuery?: string;         // 顶栏搜索框回填
  wide?: boolean;               // 宽版内容区（编辑器）
  showSidebar?: boolean;        // 默认 true；edit 传 false
  currentPath?: string;         // 侧边栏高亮目标（doc 页）
  onMount?: () => void;         // 内容已插入 DOM 后
  onTeardown?: () => void;      // 下一次替换前（比全局 teardown 更精确）
}
```

**布局 API**（`web/src/ui/layout.ts`）

```ts
layout.mount();                                  // 启动一次
layout.showBoot();                               // 仅首屏：内容区骨架
layout.show(view, { kind });                     // kind: 'initial'|'push'|'pop'|'retry'
layout.showError(title, detail?, retry?);        // 错误页也留在 shell 内
layout.setBusy(busy);                            // 顶部进度条 + aria-busy
layout.setTitle(title);                          // 页面内动态改标题（如新建→编辑）
layout.syncSidebar(currentPath?);                // 高亮 + 祖先展开 + 可见
await layout.refreshSidebar();                   // 树失效后重建（保留展开/滚动）
layout.openDrawer();                             // 移动端抽屉（自动带 currentPath）
```

## 3. 文件归属（避免并发写冲突）

| 归属 | 文件 |
|---|---|
| Lead | `web/src/main.ts`、`web/src/router.ts`、`web/src/ui/layout.ts`、`web/src/ui/view.ts`、`web/src/ui/shell.ts`、`web/src/store.ts`、`web/src/ui/scroll.ts`、`web/src/ui/sidebar.ts`、`web/src/ui/drawer.ts`、`web/src/ui/tree-model.ts`、`web/src/ui/tree.ts`、`web/src/styles/app.css`、`web/src/styles/sidebar.css`、`web/tests/tree-model.test.ts` |
| pages-dev | `web/src/pages/home.ts`、`doc.ts`、`search.ts`、`reports.ts`、`edit.ts`、`data.ts` |
| qa-dev | `web/vitest.config.ts`、`web/tests/**`（除 tree-model.test.ts）、`web/e2e/**`、`web/package.json`、`.github/workflows/ci.yml`、`web/tsconfig.json`（如需） |

**协作纪律**：只改自己归属的文件；不 `git commit/push`、不切分支、不跑 `pnpm build`（Lead 统一跑）；不重启/新增 `wrangler dev`（已有实例在 8787）。

## 4. 准出标准（Exit criteria，全部满足才算完成）

### A. 真 SPA（无整页刷新观感）

- **A1** 脚本化巡览（home → doc → wikilink doc → search → reports → doc → 后退 → 前进）全程 `performance.getEntriesByType('navigation').length === 1`，启动时写入的 `window.__kbBootAt` 不变。
- **A2** 全程 `.app-shell` / `.topbar` / `aside.sidebar` 为同一 DOM 节点（引用相等），从未被移除/重建；导航过程中不出现 `.boot-loading` 整页 spinner。
- **A3** 顶栏搜索框：输入「压感」→ 进文章 → 值仍为「压感」且未被抢焦点；回车后搜索页保留 `?q=压感`。
- **A4** 导航期间 `.page-content` 在任何时刻都不为空（旧内容保留），`aria-busy="true"` 在加载期间为真、完成后为 false。
- **A5** 滚动：长文 push 进入时 `scrollY=0`；后退回上一页 `|scrollY - 记录值| ≤ 2`；前进同理。
- **A6** `document.title` 随路由更新；未知路由在 shell 内渲染「页面不存在」（含侧边栏与搜索框）。

### B. 侧边栏

- **B1** 1280px 下 `/d/<path>/` 存在可见 `aside.sidebar`（`getBoundingClientRect().width > 100`，位于内容左侧），树节点数 > 0。
- **B2** 当前文档对应 `.tree-doc[aria-current="page"]` 唯一，其所有祖先 `<details>` 均为 open，且该节点在侧边栏可视区域内。
- **B3** 导航 home→doc→另一篇 doc：`aside.sidebar` 引用不变、`scrollTop` 不被重置（除主动 `scrollIntoView` 调整外），`/api/tree` 请求总数 ≤ 1。
- **B4** `/`、`/search`、`/reports` 有侧边栏；`/edit/...` 无侧边栏（宽版）。移动端 390px：`aside.sidebar` 不可见（`display:none`），顶栏「目录」按钮存在，点击打开抽屉，抽屉树中当前文档高亮。
- **B5** 抽屉：Esc 关闭、点遮罩关闭、点链接导航后关闭、关闭后焦点回到触发按钮、`documentElement` 无残留 `no-scroll`。
- **B6** 404 / 页面级错误态仍在 shell 内并保留侧边栏。
- **B7** 目录树加载失败时：侧边栏显示可重试错误，页面内容仍可正常使用（不整页报错）。
- **B8** 同名「目录 + 笔记」只渲染一行（真实语料 4 处）：该行点名称打开对应笔记（URL 为真实路径），点行尾箭头或「N 篇」徽标都能展开/收起子目录（两者 `aria-controls` 相同、状态同步）且不触发导航；纯目录（无同名笔记）保持 `<details>` 整行展开；两种目录行箭头都在右侧；首页/搜索/报告页侧边栏总篇数 = 真实文档数（不重复计数）。

### C. 质量门禁

- **C1** `pnpm typecheck`、`pnpm --dir web typecheck`、`pnpm test`、`pnpm --dir web test` 全绿。
- **C2** `pnpm build` 成功；JS 产物 gzip 后不超过基线 +15%（基线 index 200,611 B 未压缩，记录在 §7）。
- **C3** `node web/e2e/nav-check.mjs --base <url>` 退出码 0，JSON 报告里上述 A/B 断言全 pass。
- **C4** 巡览全程无 `console.error`、无 `pageerror`；除刻意测试的 404 外无 4xx/5xx。
- **C5** 可访问性：导航后焦点落在内容标题（或 `main[tabindex=-1]`），不丢到 `body`；侧边栏 `nav[aria-label]`、当前项 `aria-current="page"`；抽屉 `role="dialog" aria-modal="true"` 且有焦点陷阱。
- **C6** 既有行为不回归：编辑页脏检查（链接/浏览器 back/Esc/取消）、412 冲突弹层、搜索最小长度提示、报告分区重试、导出、新建弹层、TOC、表格滑动提示、深链 `#hash`。
- **C7** 3 轮以上独立对抗性审查完成；P0/P1 全部修复或书面裁定不修（记入 §7）；剩余 P2 有清单。

### D. 交付

- **D1** `web/README.md` 与本文同步更新；本文 §7 有真实验收证据（命令 + 结果）。
- **D2** 分支推送、`gh pr create` 开出 PR（含 Summary / Test plan / 风险与回滚）。
- **D3** PR 上 CI（typecheck + unit test + build）通过，或本地等价命令记录。

## 5. 非目标（明确不做）

- 不引入前端框架 / 路由器库；继续手写、继续零框架。
- 不改后端 API、不部署线上、不动 D1 数据。
- 不做视觉改版（配色/字体/间距），只加布局容器与必要样式。
- 不做 SSR / 预渲染。

## 6. 验收环境

- 构建产物由已在跑的 `wrangler dev`（`127.0.0.1:8787`，本机 D1，36 篇真实笔记，`/api/health` → `{ok:true,docs:36,stale:0}`）提供；HEAD 基线构建哈希 `index-BMUxdCWx.js`。
- 浏览器：`agent-browser`（Chromium/CDP），桌面 1280×900、移动 390×844。
- 基线取证与每轮复验命令都记录在 §7。

## 7. 验收记录（实现完成后填写）

> 全部数据为 2026-11-14 在本机实测，非推测。命令与产物哈希都记在下面，可复现。

### 7.1 基线（修复前，HEAD `20065ad` 之前的构建 `index-BMUxdCWx.js`）

用 `web/e2e/serve-dist.mjs` 把旧 dist 快照托管到 `:8899`、`/api` 反代 `:8787`，跑同一个 E2E 脚本：

```bash
node web/e2e/serve-dist.mjs --dist .reviews-tmp/ci-final/web/dist --port 8899 --api http://127.0.0.1:8787
node web/e2e/nav-check.mjs --base http://127.0.0.1:8899 --out web/e2e/reports/baseline-raw.json
node scripts/redact-evidence.mjs --in web/e2e/reports/baseline-raw.json --out docs/evidence/baseline-nav-check.json
```

结果：**desktop 2 pass / 13 fail，mobile 2 pass / 11 fail → 24 条失败**（两端各通过的 2 条是 A1、C4），逐条对应上文 P1–P3。
原始 JSON：`docs/evidence/baseline-nav-check.json`；失败项与问题的映射见 `docs/evidence/README.md`。

### 7.2 修复后（最终构建 `index-UFD7i_dS.js`）

```bash
pnpm build                                            # dist/assets/index-UFD7i_dS.js
node web/e2e/nav-check.mjs --base http://127.0.0.1:8787 --out web/e2e/reports/after-raw.json
node scripts/redact-evidence.mjs --in web/e2e/reports/after-raw.json --out docs/evidence/after-nav-check.json
node scripts/check-private.mjs                        # 必须退出码 0
```

> 原始报告含真实笔记标题，所以先落 `web/e2e/reports/`（本地、ignored），再由
> `scripts/redact-evidence.mjs` 把路径/标题换成 `doc-NN` 后才进 `docs/evidence/`。
> 下文断言明细里的 `doc-NN` 就是这套 pseudonym。

| profile | 结果 |
| --- | --- |
| desktop 1280×900 | **15 pass / 0 fail / 1 skip**（skip = B5 抽屉为移动端专用） |
| mobile 390×844 | **13 pass / 0 fail / 3 skip**（skip = B1/B2/B3 桌面专用，由桌面轮覆盖） |
| 合计 | **28 pass / 0 fail / 4 skip，退出码 0** |

两端交替覆盖后 A1–A6、B1–B8、C4、C5 全部有机器断言。关键数值（摘自报告）：

- A1 `performance.getEntriesByType('navigation').length === 1`，`timeOrigin` 全程不变，且 `__kbBootAt`（应用在 `mount()` 前写入的**数字**）前后严格相等：`1794674180883 → 1794674180883`
- A2 `.app-shell` / `.topbar` / `aside.sidebar` 引用恒等，`被移除=[]`，整页 spinner 出现 **0** 次（判据：`.state-loading` 出现在 `#app` 直接子级或 `.page-content` 之外）
- A3 搜索框值「压感」跨 4 次导航保留，`activeElement` 从不是搜索框
- A4 导航中 `.page-content` 空内容采样 = 0，`aria-busy` true/false 严格成对（9/9）
- A5 push=0；back 恢复 400（记录 400）；forward 恢复 300（记录 300）；深链锚点 `rect.top=80`
- B1 侧边栏宽 280、`left=74 < 内容 left=382`、树节点 36
- B2 `aria-current` 唯一、两层合并行祖先全部展开、节点在可视区
- B3 侧边栏引用不变、`scrollTop` 120→354 不被重置、本次导航 `/api/tree` = 0 次
- B4 桌面 `/`、`/search`、`/reports` 有侧边栏；`/edit/` 无侧边栏且宽版；移动端侧边栏 `display=none` 且有「☰ 目录」按钮
- B5 抽屉 `role=dialog aria-modal=true`、36 个节点、焦点陷阱；Esc / 遮罩 / 点链接三条关闭路径都通过，`no-scroll` 无残留，焦点回触发按钮
- B6 未知路由与缺失文档都留在 shell 内并保留侧边栏
- B7 树加载失败 → 侧边栏可重试错误、正文可用；重试后恢复 36 篇
- B8 四处同名冲突各只有 1 行；箭头与「N 篇」徽标都能折叠子列表（徽标点后箭头 `aria-expanded` 同步、受控列表 `hidden=false`，实测「6 篇」徽标 true）
- C4 `console.error=0`、`pageerror=0`、`unhandledrejection=0`、非预期 4xx/5xx=0
- C5 导航后焦点落在 `.page-content` 内、抽屉内 Tab×4 焦点不逃逸

### 7.3 单测与门禁（C1 / C2 / D3）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过 |
| `pnpm --dir web typecheck` | 通过（`web/tests/**` 也在 include 内，测试本身受类型检查） |
| `pnpm test` | 6 文件 / **64 用例** 全绿（后端，未改动） |
| `pnpm --dir web test` | 5 文件 / **103 用例** 全绿 |
| `pnpm build` | 成功，`dist/index-UFD7i_dS.js` |

前端 103 个用例分布：

| 文件 | 用例 | 覆盖 |
| --- | --- | --- |
| `web/tests/router.test.ts` | 28 | `parseRoute`/URL 构造、navigate push/replace/同页早退、脏守卫取消、popstate 语义、hash-only 不重渲染、链接点击接管 |
| `web/tests/scroll.test.ts` | 21 | key + 内存记账、跨刷新兜底、push/replace/`replaceEntryKeepScroll`、节流定时器竞态回归、`scrollToTop`/`restoreScroll`/`scrollToHash` |
| `web/tests/layout.test.ts` | 26 | mount 幂等、只换 `.page-content`、`aria-busy` + 150ms 进度条、title/searchQuery/wide/showSidebar、`showError` 留在 shell、onMount/onTeardown 顺序、滚动三态、焦点管理 |
| `web/tests/sidebar.test.ts` | 12 | **保存→invalidateTree→侧边栏刷新整链**、事件自激环回归、刷新失败提示、合并行契约、`aria-controls` 指向、增量高亮不重建 DOM |
| `web/tests/tree-model.test.ts` | 16 | 同名合并、`countDocs` 不重复计数、`ancestorsOf`、`mergeOpenPaths`、合并行 DOM 契约（含「N 篇」徽标可点/与箭头状态同步） |

**产物体积（C2）**：基线 `index` 未压缩 **200,611 B**；最终 `index-UFD7i_dS.js` = **213,000 B 未压缩 / 81,770 B gzip**。
未压缩 +6.1%、gzip 侧 +0.5 kB 量级，**远低于 +15% 上限**。CSS 31.8 → 32.2 kB（gzip 6.94 → 7.01 kB）。

### 7.4 三轮对抗性审查（C7）

三轮审查独立进行（不同审查者、不同侧重），共提出 6 个 P0/P1 与若干 P2/P3。

| 轮次 | 侧重 | 结论 |
| --- | --- | --- |
| 第 1 轮 | 代码正确性 / 竞态 / 历史栈 | 修完 P1 可以上线；报 3 个 P1 |
| 第 2 轮 | 产品行为 / 既有功能回归 | 修完 P1 可以上线；报 2 个 P1（含「箭头根本不可见」） |
| 第 3 轮 | 最终门禁 / 逐条对照准出标准 | **可以上线**，无 P0/P1 |

**已修复（全部有实测复现与回归测试）**

| # | 级别 | 问题 | 修复 |
| --- | --- | --- | --- |
| 1 | P1 | **侧边栏箭头完全没有视觉呈现**（空 `<span>`，无 `content`、无边框背景，实测 0×12 全透明）——用户「点右边箭头展开树」这个原始需求实际未交付 | `app.css` 的 `.tree-caret::before { content: '▸' }`，保留旋转；两个方向实测 `matrix(1,0,0,1)` vs `matrix(0,1,-1,0)` |
| 2 | P1 | **点「当前正在看的这篇」会重复导航**：多压一条历史、跳回顶部（实测 `histLen 2→3`、`y 600→0`） | `navigate()` 增加同页早退（`isSamePage`，忽略 hash 与尾斜杠、保留 query） |
| 3 | P0 | **`kb:tree-invalidated` 事件自激环**：`loadTree(force)` → `invalidateTree()` → 派发 → sidebar `refresh()` → `loadTree(true)` → …（实测**一次派发引发 43 次嵌套派发**，只靠浏览器事件嵌套上限才停） | `store.ts` 拆出 `clearTreeCache()`（只清缓存）与 `invalidateTree()`（清缓存并广播）；实测降到 1 次 |
| 4 | P1 | `navigate()` 早退让**首页「重建索引」永久卡在「重建中…」**（成功路径不恢复按钮） | `navigate(..., { force: true })` 跳过同页判断，仍走 replace 不压历史 |
| 5 | P1 | **过期渲染改写地址栏**：点击后请求未返回就导航走，旧渲染 `replaceUrl()` 会把新条目改成旧文档 URL，导致地址栏与正文错位、之后点那篇「没反应」 | `replaceUrl(to, expectedUrl)` 校验「地址栏仍是我以为的那一页」；`doc.ts`/`edit.ts` 传入起始 URL |
| 6 | P1 | **侧边栏刷新失败被静默吞掉**：树保持旧状态、无错误无重试，用户以为保存没生效 | `renderBody` 在有旧树时也渲染薄提示条 `.sidebar-error-thin`（「目录可能不是最新的」+ 重试） |
| 7 | P2 | 滚动 120ms 节流定时器跨条目未取消，旧页面滚动位置可能记到新条目 | `cancelPendingScrollTimer()` 在 `pushEntry`/`replaceEntry`/`adoptEntryKey` 中调用 + 2 个回归用例 |
| 8 | P2 | 移动端合并行箭头触控区仅 20×20（项目自己在 `app.css` 写明「触控目标统一 ≥44px」） | `@media (max-width:860px)` 下 44×44，视觉箭头不变，`margin-right:-12px` 保持对齐；390/320px 实测不与计数重叠、无横向溢出 |
| 9 | P2 | **移动端抽屉不随浏览器后退关闭**：内容已换页、抽屉还盖着、`no-scroll` 锁死整页（真机安卓返回手势就是这个路径） | 抽屉额外监听 `popstate` |
| 10 | P2 | 同词再按「搜索」完全无反应（错误态下也无法重试） | 搜索表单用 `navigate(url, { replace: true, force: true })` |
| 11 | P2 | 正文里指向**本文某节**的链接点了没反应（点击委托已 `preventDefault`，同页早退把原生 fragment 滚动也吃了） | 同页但 hash 不同时自行 `scrollToHash()`，不重渲染 |
| 12 | P2 | 标题「复制本节链接」用 `replaceState(null)` 抹掉 `kbKey`，该条目之后后退回顶部 | 改为保留 `history.state` 后再改 hash |
| 13 | P3 | `web/index.html` 缺 favicon 导致每次访问多一个 `/favicon.ico` 404 | 内联 SVG data-URI（无额外请求） |
| 14 | P3 | `createSidebar` 没有清理接口，测试里多实例会串扰 | `SidebarHandle.destroy?()` 解绑全局监听 |
| 15 | P2 | **（用户验收反馈，2026-11-15）** 合并行的「N 篇」徽标是纯 `<span>`，点了没反应；手习惯落在徽标上，只能去够行尾小箭头 | 徽标改成 `<button type="button" class="tree-count-btn">`，与箭头共用同一个 `aria-controls` / `aria-expanded`，点任一处另一处同步；补 hover/focus 样式与移动端 44px 命中区；单测 + 端到端各加断言（B8 实测：箭头 true→false 时徽标同步 false，点「6 篇」徽标回到 true 且受控列表 `hidden=false`） |

**收尾自查：砍掉两条「恒真断言」（假绿）**

三轮审查都独立点到同一处：E2E 报告全绿，但其中两条断言在实现上不可能失败，所以「全绿」对 A1/A2 没有证明力。收到裁定后重做了这两条，并在最终构建上重跑全量：

| 断言 | 假绿写法 | 为什么恒真 | 现在的判据（最终构建实测） |
| --- | --- | --- | --- |
| A1 | `ctx.boot.bootAt === null \|\| finalMeasure.bootAt === ctx.boot.bootAt` | `__kbBootAt` 这个窗口变量在应用代码里**根本没人写入**，两边永远是 `null`，`null === null` 恒真 | `main.ts` 在 `mount()` **之前**写入 `window.__kbBootAt = Date.now()`；断言要求两侧都是 `number` 且严格相等。实测 `1794674180883 → 1794674180883`（桌面）、`1794674202126 → 1794674202126`（移动） |
| A2 | 计数 `.boot-loading` 的出现次数 | 应用代码里**从来不存在** `.boot-loading` 这个类名（首屏用的是 `.state-loading`），所以计数恒为 0 | `collector.js` 改为对 `.state-loading`/`.boot-loading` 判「是否整页加载」：作为 `#app` 直接子级、或出现在 `.page-content` 之外才计数；`measure()` 里 `bootLoading` 同时检查 `#app > .state-loading` 与 `.app-shell` 缺失。实测两端 `bootSpinner=0` |

加固后重跑：desktop 15 pass / 0 fail / 1 skip、mobile 13 pass / 0 fail / 3 skip → **28 pass / 0 fail / 4 skip，退出码 0**（`docs/evidence/after-nav-check.json`，构建 `index-UFD7i_dS.js`）。

**变异验证（证明这两条现在会真的红）**：把加固后的脚本对着**旧构建** `index-BMUxdCWx.js`（§7.1 的同一份 dist 快照）跑 desktop 轮：

```powershell
node web/e2e/serve-dist.mjs --dist .reviews-tmp/ci-final/web/dist --port 8899 --api http://127.0.0.1:8787
node web/e2e/nav-check.mjs --base http://127.0.0.1:8899 --profile desktop
```

结果 **1 pass / 14 fail / 1 skip，退出码 1**：唯一的 pass 是 C4，**A1 由旧脚本下的 pass 翻成 fail**（`__kbBootAt=null→null`，探针缺失即判红），A2 也因真实整页 spinner 判红。即“全绿”不再可能靠恒真式伪造。

**书面裁定不修（记录在案）**

| 问题 | 为什么不修 |
| --- | --- |
| 脏离开守卫取消 `back` 时，`pushState` 会截断前进历史（`history.length` 不变但栈内容被改写） | 这是「拦截 back 后把地址栏推回去」这种做法的固有代价，`history.length` 不增长（实测连续 5 轮 `back`+取消稳定在 4）。彻底修正需要改成「popstate 后确认、取消时 `history.go(1)`」，涉及改动编辑器离开流程的核心语义，风险大于收益；已记入后续待办。 |
| 被顶替的渲染仍会注册编辑页全局监听（Esc / Ctrl+S 指向旧文档），要到下次导航才清掉 | 触发条件是「进编辑页的 `loadDoc` 未返回时立刻导航走」这一窄窗口。修复方向是把全局副作用从页面工厂后移到 `onMount`，属于跨 6 个文件的结构性调整；已记入后续待办，本轮不做以免扩大回归面。 |
| `positions` Map 只增不删 | 每个条目几十字节，长会话下实际内存占用可忽略；加淘汰策略反而可能淘汰仍需要的条目。 |
| 同源非页面链接（如 `/api/export`）会被 SPA 吞成 404 | 当前仓库没有任何这样的 `<a href>`（导出走 fetch+blob）；已知限，需将来加前缀白名单。 |
| 编辑页侧边栏关闭时不再提供「目录」抽屉入口 | 有意为之（契约 §2.9）：编辑页是宽版沉浸编辑，给一个点了没东西的按钮更糟。 |

**审查指出的测试盲区及处置**：三轮都点名「保存 → invalidateTree → 侧边栏刷新」这条链没有自动化覆盖，而 P0 自激环恰好藏在里面。已新增 `web/tests/sidebar.test.ts`（12 例），直接覆盖该链路、自激环回归、刷新失败提示、合并行契约与增量高亮；该文件在编写过程中立刻又暴露了一个真实缺陷（`createSidebar` 缺 `destroy()`），已一并修复。

### 7.5 PR

分支：`fix/web-spa-nav-sidebar`（基于 `main`），PR：<https://github.com/Enter-tainer/agent-knowledge/pull/2>

- CI `test`（GitHub Actions：typecheck + 单测 + build）**通过**。
- `Workers Builds: agent-knowledge` 显示 **fail**，但 `started_at == completed_at`（0 秒，实际没有执行构建）。已在 `main` 的历史提交上复核同一现象（`e4719be`/`52abb90`/`cea604d`/`fe7cf99` 都是 0 秒失败，只有专门修 CI 的 `8308b80` 是 success），并用「干净 clone 本分支 + `pnpm install --frozen-lockfile` + `pnpm build`」和 `wrangler deploy --dry-run`（130.04 KiB / gzip 33.88 KiB）在本地复现成功，结论是既有基础设施问题，非本 PR 引入。

验收口径以本文 §4 为准；`docs/evidence/` 下的两份 JSON 是 §4 里 A/B 类的机器证据，可用 §7.1/§7.2 的命令原样复跑。

