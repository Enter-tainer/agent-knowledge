# 前端导航 / 侧边栏修复：设计契约、准出标准与验收记录

> 分支：`fix/web-spa-nav-sidebar`　目标：修掉「切换页面像整页刷新」和「文章页没有目录侧边栏」。
> 本文是**唯一契约**：实现、测试、对抗性审查都以本文为准。验收结果追加在 §7。

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
- **B8** 同名「目录 + 笔记」只渲染一行（真实语料 4 处）：该行点名称打开对应笔记（URL 为真实路径），点行尾箭头展开/收起子目录且不触发导航；纯目录（无同名笔记）保持 `<details>` 整行展开；两种目录行箭头都在右侧；首页/搜索/报告页侧边栏总篇数 = 真实文档数（不重复计数）。

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

_待填：基线失败证据、修复后 A/B/C 逐条结果、性能与产物体积对比、3 轮对抗审查结论、PR 链接。_
