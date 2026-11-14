# 验收证据（web-nav-sidebar 修复）

本目录是 `fix/web-spa-nav-sidebar` 的**机器可复现证据**，由 `web/e2e/nav-check.mjs` 生成。
术语与准出标准见 [`docs/web-nav-sidebar-acceptance.md`](../web-nav-sidebar-acceptance.md) §4。

## 文件

| 文件 | 说明 |
|---|---|
| `baseline-nav-check.json` | **修复前**：HEAD 旧构建（`index-BMUxdCWx.js`）在 36 篇真实语料上的 full sweep（桌面 1280×900 + 移动 390×844） |
| `after-nav-check.json` | **修复后**：新构建产物（`index-pVuRVRx_.js`）同一脚本、同一数据的 full sweep |

两份报告的 `build.asset` 字段写明被测 bundle，`fixture` 字段写明自动选中的巡览文档与
「目录+同名笔记」碰撞列表，可直接对比。

## 基线怎么复现

旧 dist 已不在 `web/dist`（被新构建覆盖），但仓库里有 HEAD 的构建快照
（`.reviews-tmp/ci-final/web/dist`）。用自带的静态服务器把快照挂起来、`/api/*` 反代到
本机 `wrangler dev`，即可对「旧前端 + 真实后端数据」重跑：

```powershell
# 终端 A：把旧 dist 托管到 8899，API 借 8787 的 wrangler dev（只读，不动 D1）
node web/e2e/serve-dist.mjs --dist .reviews-tmp/ci-final/web/dist --port 8899 --api http://127.0.0.1:8787

# 终端 B：跑基线
node web/e2e/nav-check.mjs --base http://127.0.0.1:8899 --out docs/evidence/baseline-nav-check.json
```

## 修复后结果（after-nav-check.json）

被测产物 `index-pVuRVRx_.js`（`pnpm build` 后由 `wrangler dev` 在 8787 提供），同一份 36 篇真实语料：

| profile | pass | fail | skip |
|---|---|---|---|
| desktop 1280×900 | 15 | **0** | 1（B5：抽屉只在移动端存在） |
| mobile 390×844 | 13 | **0** | 3（B1/B2/B3：桌面专用断言） |
| **合计** | **28** | **0** | 4 |

退出码 0。逐条对照：

- 基线失败 24 条 → 全部转 pass（A2/A3/A4/A5/A6/B1/B2/B3/B4/B6/B7/B8/C5，两端各有覆盖）；
- 基线已通过的 A1/C4 → 修复后仍通过（无回归）；
- 关键数值：`scrollY` push=0 / back 恢复 400（记录 400）/ forward 恢复 300（记录 300）；
  `#hash` 深链锚点 `rect.top=80`；侧边栏 `scrollTop 120→354` 不被重置、单次导航 `/api/tree=0`；
  4 处同名合并行各 1 行；全程 `console.error=0 / pageerror=0 / 非预期 4xx-5xx=0`。
- skip 均为**按 profile 不适用**（桌面没有抽屉、移动端侧边栏隐藏），不是未验证；
  移动端的 B4/B5 与桌面的 B5 交替覆盖，两端合起来 A/B 条款全覆盖。

## 基线失败项 → 对应问题

修复前的 24 条失败与文档 §1 的 P1-P3 一一对应：

| 失败条款 | 基线实测 | 对应问题 |
|---|---|---|
| **A2** | 每次导航 `.app-shell` / `.topbar` / `aside.sidebar` 全被移除并重建（桌面轮累计记到 8 次 `.app-shell`、3 次 `aside.sidebar` 移除，整页 spinner 累计 9 次） | P1 整页刷新观感 |
| **A4** | 根本没有 `.page-content` 容器（`内容子节点=-1`），`aria-busy` 从未出现 | P1 |
| **A3** | 导航后顶栏搜索框被重建，值从「压感」丢成 `""` | P1（顶栏每页重建） |
| **A5** | push 后回顶正常，但 back/forward 的 `scrollY` 都是 0（记录值 400 / 300 丢失） | P1（无滚动恢复） |
| **A6** | 未知路由页面没有侧边栏（`侧边栏=false`），且内容区文案不含「页面不存在」 | P1 |
| **B1 / B2 / B3** | `/d/<path>/` 页 `aside.sidebar` 宽 0、树节点 0；无 `aria-current` | **P2 文章页无侧边栏** |
| **B4**（桌面） | `/search`、`/reports` 无侧边栏；`/edit/` 反而没有 `aside` 但宽版正常 | P2 |
| **B4 / B5**（移动） | 顶栏没有「☰ 目录」按钮，移动端无法打开目录抽屉 | **P3 移动端无目录入口** |
| **B6** | 404 / 缺失笔记页没有侧边栏 | P2 |
| **B7** | 树请求失败时侧边栏不存在，无从显示可重试错误 | P2 |
| **B8** | 4 处「目录+同名笔记」碰撞在树里各出现 0 行（基线树里根本没有合并行结构） | 新增条款 |
| **C5** | 导航后焦点落在 `BODY`，没有落到内容标题 | P1 |
| **A1 / C4** | 通过（基线确实是 SPA，也没有 console error） | — |

## 复跑修复后证据

```powershell
# 需要先在仓库根起 wrangler dev（127.0.0.1:8787，真实 36 篇）
pnpm dev
# 另一个终端：构建产物 + 验收
pnpm build
node web/e2e/nav-check.mjs --base http://127.0.0.1:8787 --out docs/evidence/after-nav-check.json
```

退出码 0 = 全部机器断言通过；详细判据见 [`web/e2e/README.md`](../../web/e2e/README.md)。

## 安全

报告只含 URL 路径、断言明细、DOM 文本摘要与错误消息，**不含** token / secret / 绝对文件路径。
但 `fixture` 与断言明细里会出现本机笔记标题（真实语料），
如仓库要开源，请确认本目录是否适合随仓库发布（或只保留在本地）。
