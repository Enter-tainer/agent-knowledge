# web/ —— 私有知识库前端

Vite + TypeScript，**不用前端框架**；markdown-it@15 渲染，两个自写插件（wikilink / callout）。
产物 `web/dist` 由 Worker 作为静态资源挂在同源根路径（`wrangler.toml` 的 `[assets] directory = "./web/dist"`）。

## 快速开始

```powershell
cd web
pnpm install
pnpm dev          # 默认 mock 模式（不依赖后端），http://127.0.0.1:5173
pnpm build        # tsc --noEmit && vite build → dist/index.html + dist/assets/*
pnpm preview      # 本地预览构建产物（/api 仍需要真后端）
pnpm typecheck    # 只查类型
```

`pnpm dev` 默认用 `src/mock/notes/*.md` 里的 5 篇假笔记（表格 / callout / 双链 / 断链 / 无入链都有），
所以**没有后端也能看全部页面**。顶部会显示黄色 `MOCK` 徽标，避免把假数据当真数据。

## 鉴权（前端零参与）

- **本地**：`wrangler dev` 只监听 `127.0.0.1:8787`，Worker 对 loopback 不鉴权 → 直接
  `http://127.0.0.1:8787` 即可（`pnpm build` 后由 Worker 同源提供）。
- **线上**：唯一入口是挂了 **Cloudflare Access** 的自定义域（`workers_dev = false`）。
  Access 登录是浏览器 cookie，前端**不存 token、不发 `Authorization` 头**，也没有登录页。
- 401 只可能是「Access 没放行」，页面显示「没有访问权限（请确认已登录 Cloudflare Access）」并提供重试。

## 切真接口（本地开发）

| 场景 | 命令 | 说明 |
|---|---|---|
| 本地 dev + Vite 代理（推荐） | `$env:VITE_DEV_PROXY_TARGET='http://127.0.0.1:8787'; pnpm dev` | 同源 `/api` 转发到 `wrangler dev`，免 CORS、免鉴权 |
| 本地 dev + 直连后端 | `$env:VITE_API_BASE='http://127.0.0.1:8787'; pnpm dev` | 跨域，后端需放行 CORS |
| 生产构建 | `pnpm build` | 默认 baseURL = 空串（同源），由 Worker 同时提供 `/api` 与静态资源 |

强制开关：`VITE_MOCK=1` / `VITE_MOCK=0`（优先级最高，例如 `$env:VITE_MOCK='1'; pnpm build` 可构建纯 mock 的静态 Demo）。

## 页面与路由（History API，无 router 库）

| 路由 | 内容 |
|---|---|
| `/` | 桌面：左侧可折叠路径树 + 右侧最近更新；手机：目录改为**全屏抽屉**（顶层目录默认收起、关闭按钮固定）。`/api/health.stale > 0` 时给「重建索引」按钮（真的调 `POST /api/admin/reindex`） |
| `/d/<path>/` | 正文（表格可横滑 + 提示、callout、代码高亮、双链可点）+ **本页目录（heading 锚点）** + 「哪些笔记提到了这篇」/「这篇引用的笔记」+ 折叠的「版本信息」 |
| `/edit/<path>/` | 桌面左右分栏、手机「源码 / 预览」Tab；保存带 `If-Match`；Ctrl/Cmd+S；**有未保存改动时拦截所有站内离开**（返回/取消/浏览器 back/顶栏链接） |
| `/edit/<path>/?new=1` | 新建：空模板，首次保存用 `If-Match: *`；路径已被占用会提示打开现有的 |
| `/search?q=` | 标题 + 所在小节 + 摘要（`<mark>`，已剥 frontmatter/标记）；空结果/1 字提示都给「回目录 / 清空重搜 / 示例词」 |
| `/reports` | 断链、无入链；两个区块**各自可重试**，500 会显示「服务暂时不可用 + requestId」 |

顶栏：目录 / 报告 / **＋ 新建** / 导出（导出后 toast 说明篇数与大小）。

路径在 URL 里逐段 `encodeURIComponent`，且**结尾带 `/`**（Vite dev / 静态托管 SPA fallback 对无扩展名路径更稳；
`.../BLE 协议与 .dat 文件格式` 这种带点的路径如果不带尾斜杠会被当成静态文件 404）。

`wikilink` 用的是短名（`[[笔输入通路与压感真相]]`），所以 `/d/<短名>/` 拿到 404 时会用目录树把它解析成
真实路径、替换地址栏后再加载（等价于后端 §6.3 的「全库唯一文件名」规则）。

## 渲染管线（`src/markdown/`）

- `html: false`：语料里的原始 HTML 一律当文本，从根上没有 XSS 面（不需要 DOMPurify）。
- `src/markdown/wikilink.ts`：`[[目标]]` → `<a class="wikilink" data-target="目标">目标</a>`；
  **插件里不发请求**，由文档页的事件委托 `navigate('/d/' + encodeURIComponent(target) + '/')`。
  target/文本都走 `escapeHtml`，不拼 innerHTML（有专门的 XSS 自测）。
- `src/markdown/callout.ts`：core 规则把 `> [!tip] 标题` / `> [!note] 标题` 的引用块拆成
  `<blockquote class="callout callout-tip|note"><p class="callout-title">…</p>正文</blockquote>`；
  **未知类型（`> [!warning]` 等）原样降级**为普通 `<blockquote>`。
- `src/markdown/highlight.ts`：highlight.js core + 只注册语料里出现的语言（powershell/bash/python/c/java/
  js/json/xml/yaml/dos/http），别名归一 `pwsh → powershell`、`sh → bash`、`cmd → dos`。
- `src/markdown/index.ts`：
  - **heading id**：`heading_ids` core 规则给每个标题生成稳定 slug（中文保留、重复加 `-2`），并插入 `#` 锚点
    （点击复制该节链接），文档页据此生成 TOC；
  - 渲染前预处理（只在围栏代码块之外）：
    1. 表格里的 `<br>` → 空格（语料里 3 个文件有；`html:false` 下否则会显示成字面量 `<br>`）；
    2. **中文标点后的粗体闭合**：CommonMark 下 `**本页用途：**汉字` 因 right-flanking 规则不成立，
       会显示成字面量 `**`（真实语料实测 **164 处**）。修法是在闭 `**` 前插入零宽空格（U+200B），
       视觉无变化，且只作用于渲染管线（保存的 raw 不含 ZWSP）；
  - `pre` / `.table-wrap` 带 `tabindex=0`，键盘可聚焦滚动。

## 目录结构

```
web/
├── index.html
├── vite.config.ts          # base=/；dev 可代理 /api；构建 outDir=dist
├── src/
│   ├── main.ts             # 启动 / 路由分发 / 错误兜底 / 深链锚点 / （仅 dev）window.__kb
│   ├── router.ts           # parseRoute / navigate / 链接点击接管 / popstate+哈希处理
│   ├── navGuard.ts         # 离开守卫（编辑页脏检查，所有站内跳转共用）
│   ├── store.ts            # 目录树缓存 + 短名→真实路径解析
│   ├── api/                # contract.ts（KbApi）、http.ts（真接口）、mock.ts、types.ts、errors.ts（humanizeError）
│   ├── markdown/           # 渲染管线 + 两个插件 + heading id
│   ├── pages/              # home / doc / edit / search / reports
│   ├── ui/                 # shell（顶栏/弹层/toast）、tree、dom、lifecycle、newNote（新建弹层/路径查重）
│   ├── styles/app.css      # 全部样式（黑白灰 + 一个强调色，含移动端）
│   └── mock/notes/*.md     # 5 篇 mock 笔记（只在 mock 模式加载）
└── dist/                   # 构建产物（git 忽略）
```

## 接口契约

| 前端调用 | 后端接口 |
|---|---|
| `api.health()` | `GET /api/health` → `{ok, tokenizerVersion, docs, stale}` |
| `api.tree({prefix,limit})` | `GET /api/tree` |
| `api.getDoc(path, ifNoneMatch?)` | `GET /api/docs/{path}`；响应带 `ETag: "<hash>"`，304 时也带（前端发裸 hash，后端会剥引号/W/） |
| `api.putDoc(path, raw, ifMatch)` | `PUT /api/docs/{path}`；已存在文档必须带当前 hash（缺失或 `*` → **428**，不匹配 → **412**）；`If-Match: *` 只用于新建 |
| `api.reindex()` | `POST /api/admin/reindex`（首页「重建索引」按钮） |
| `api.rename(path, to)` | `POST /api/docs/{path}/rename`（已封装，UI 未接按钮） |
| `api.search(q, limit)` | `GET /api/search` |
| `api.backlinks(path)` / `api.links(path)` | `GET /api/docs/{path}/backlinks` / `.../links` |
| `api.reportLinks(true)` | `GET /api/reports/links?unresolved=1` → `{unresolved:[…], count}` |
| `api.reportLinks(false)` | `GET /api/reports/links` → `{links:[{…,resolved,dstPath}], count}`（已封装，报告页只用断链） |
| `api.orphans()` | `GET /api/reports/orphans` |
| `api.exportZip()` | `GET /api/export?format=zip`（fetch → blob → 下载） |

后端返回的额外字段（如 PUT 的 `chunks/links`）前端会忽略，不破坏契约。

**保存/冲突流程**：正常保存只发 `If-Match: <当前 hash>`。收到 412/428 时弹层（人话文案）：
「重新加载（推荐）」丢本地改动取服务器版本；「用我的版本覆盖」= 先 GET 最新 hash 再用该 hash PUT
（严格语义下 `If-Match: *` 只能新建），且会二次确认；另有「继续编辑」可先不处理。

**离开守卫**：编辑页有未保存改动时，点任何站内链接（返回阅读/取消/顶栏/双链）、浏览器 back、
拖出页面都会先确认「保存并离开 / 放弃修改 / 继续编辑」；保存成功或放弃后清除脏标记。

## 已知限制 / 取舍

1. **P2 未做的项**：深色模式（`color-scheme: light`，夜间仍是白底）；代码高亮主题仍是 github.css，
   `.hljs-keyword` 在 13px 下对比度约 4.30:1（AA 需 4.5）；反链面板仍在正文末尾（长文需滑到底，
   未做桌面侧栏）；出链跳转不定位到具体行（行号已从 UI 去掉，避免「看着像链接点不动」）。
2. **未接 UI 的接口**：`rename`、`DELETE /api/docs` 只封了 client，没有按钮。
3. **mock 是简化实现**：搜索是子串匹配（不是 bigram+FTS5），rename 只做简单替换，`exportZip` 返回纯文本占位
   （不是真 zip），`getDoc` 的 304 只在传 `If-None-Match` 时生效；`putDoc`/`reportLinks`/`reindex` 已按契约实现。
4. **搜索摘要清洗是前端兜底**：`cleanSnippet` 会剥 frontmatter / callout / 表格竖线 / 强调标记，
   但索引侧仍应跳过 frontmatter（后端已另修）；摘要与原文格式不完全一致。
5. **没有图片/附件/嵌入**：语料本身无附件（ADR-10 明确不做）；`![[…]]` 嵌入不支持，会按普通文本渲染。
6. **冲突检测只在保存时**：没有「别人正在编辑」的实时提示；强制覆盖的 GET+PUT 之间若再被改，会再次弹 412。
7. **新建笔记的标题**：标题由后端从 H1 / 文件名推导；前端默认写入 `# <文件名>`，改标题需要手动改 H1。
8. **生产 bundle 带一个 `mock-*.js` 延迟 chunk**（≈5.8KB gzip，含 5 篇假笔记），首屏不加载、mock 关闭时不会请求。

## UX 审查修复记录（2026-11-12，对照 `reviews/ux-20261112.md`）

P0/P1 全部处理：

| 项 | 处理 |
|---|---|
| P0 未保存改动静默丢失 | `navGuard` + 路由层拦截：返回/取消/顶栏/双链/浏览器 back 都弹「保存并离开 / 放弃修改 / 继续编辑」；`beforeunload` 保留；保存成功清脏 |
| 412 弹层黑话/无推荐/无取消/无二次确认/焦点丢失 | 文案改人话 + 明确推荐「重新加载」；加「继续编辑」；打开后焦点进弹层（Tab 焦点陷阱）；「用我的版本覆盖」二次确认；428 同流程 |
| 手机编辑区 282px / 13.5px | 头部 327px→约 160px（详情折叠、标题独立一行、保存移到底部操作条）；源码/预览 Tab；textarea 高度按实测顶栏算（450px+）、字号 16px |
| 6 列表格切半/无提示 | 溢出表格加「← 左右滑动查看完整表格 →」+ 右侧阴影；表格字号 14px；单元格最小宽 92px；页面级无横向溢出 |
| 搜索摘要 YAML | `cleanSnippet` 剥 `---` frontmatter / 元数据行 / callout 标记；摘要与标题重复时不显示 |
| 报告页 internal error 无重试 | 区块级错误样式 + 人话文案 + requestId（500 时 console 也打印响应）+「重试」按钮（重跑该区块） |
| 文档 404 英文 + 假重试 | 「没有这篇笔记」+ 搜索这个标题 / 回目录 / 新建 + 「你可能想找」同名词条；真网络错误才给重试（重请求当前路径） |
| 手机目录 4500px、收起滚走 | 目录改全屏抽屉：关闭按钮固定、顶层目录默认收起、长标题折 2 行、打开时锁定页面滚动 |
| 标题+路径重复 | 列表只显示父目录；手机隐藏路径；反链/报告同样处理 |
| 长文无 TOC/无锚点 | heading 稳定 id + `#` 锚点（点击复制本节链接）+「本页目录」（手机默认收起，点击跳转） |
| 技术黑话 | `hash/rev` 收进折叠「版本信息」（显示为「版本 xxxx · 第 N 次保存」）；「反链」→「哪些笔记提到了这篇」（「提到 N 次」）；行号从 UI 去掉；bm25 分数不显示；索引告示改成按钮「重建索引」；1 字搜索文案去开发者解释 |
| 触控目标 <44px | ≤860px 统一：导航/按钮/搜索/树项/列表项/弹层按钮 ≥44px（首页实测 0 个可点元素 <44） |
| 无新建入口 | 顶栏「＋ 新建」→ 路径弹层（默认 `未命名-时间`、路径查重）→ `/edit/<path>/?new=1`，首次保存用 `If-Match: *`，创建后地址栏去掉 `?new=1` |

顺带做的 P2：日期只有日期时不补 `08:00`；每页 `document.title`；空结果/1 字搜索给可点示例；
搜索结果整卡可点；未知路由套正常 shell（带搜索框）；编辑页 Esc 也走离开确认；导出 toast 说明篇数与大小；
`pre`/表格容器可键盘聚焦。

### 复验截图（`web/.scratch/`，git 忽略）

| 文件 | 内容 |
|---|---|
| `fix-home-mobile.png` | 390 首页：无标题/路径重复、触控目标 |
| `fix-home-mobile-drawer.png` | 手机目录抽屉：顶层收起、关闭按钮固定 |
| `fix-edit-mobile.png` / `fix-edit-mobile-preview.png` | 手机编辑：头部精简、源码/预览 Tab、底部保存条 |
| `fix-edit-conflict-mobile.png` | 手机 412 弹层：人话 + 推荐 + 三个选项（46px 按钮） |
| `fix-doc-mobile-toc.png` / `fix-doc-mobile-table.png` | 手机文档：TOC（默认收起）、版本信息折叠、宽表格滑动提示 |
| `fix-doc-404-mobile.png` | 404：人话 + 搜索/回目录/新建 + 同义词条 |
| `fix-search-mobile.png` | 搜索：摘要无 YAML/标记，无 bm25 分数，整卡可点 |
| `fix-home-desktop.png` | 桌面回归：左侧树 + 最近更新 |

## 本地自测记录（2026-11-12，UX 修复之后）

- `cd web && pnpm install && pnpm build` 通过；产物 `dist/index.html` + assets（JS ≈77.9KB gzip / CSS ≈6.3KB gzip）。
- 真接口（`VITE_DEV_PROXY_TARGET=http://127.0.0.1:8787`，36 篇）逐项复验：
  - 编辑 dirty 拦截：改内容 → 点「返回阅读」/浏览器 back 都弹确认；「继续编辑」留在原页且内容在；
    「放弃修改」跳转且内容丢弃；「保存并离开」先保存再跳转（服务器内容已更新）。
  - 412：真实后端制造冲突 → 新文案弹层 →「重新加载」取回最新版；「用我的版本覆盖」二次确认后写入，
    服务器内容 == 编辑器内容；428 分支用注入的 `PreconditionRequiredError` 验证同弹层。
  - 手机 390×844：编辑页头部 162px（原 327）、textarea 450px（原 282）、字号 16px、无横向溢出；
    BLE 长文 13 个表格中 6 个加滑动提示、字号 14px、页面 `scrollWidth === 390`；TOC 30 节、31 个 heading 全有 id。
  - 搜索「压感」8 条：摘要无 frontmatter/`**`/反引号、无 bm25 胶囊、整卡可点。
  - 报告错误态：注入 500（带 requestId）→「服务暂时不可用，请稍后重试（请求 ID：…）」+ 重试，
    恢复后重试成功；正常态断链 0 / 无入链 3。
  - 新建：顶栏「＋ 新建」→ 默认路径 → 输入 `_webui/我的测试笔记` → 空模板编辑 → 保存 `If-Match:*`
    → 创建成功、树 37 篇、地址栏去掉 `?new=1`；重复路径输入「索引与读取约定」提示「这个路径已经有笔记了」。
  - 收尾清理：`DELETE /api/docs/_webui/我的测试笔记` → 404，`/api/health` = `{docs:36, stale:0}`，树 36 篇。
- mock 模式另验：stale 提示条 +「重建索引」按钮（toast「搜索索引已重建完成」）、`/login` 走「页面不存在」、
  401 显示「没有访问权限」不跳登录。
- XSS：编辑器预览里输入 `<img onerror>`、`<script>`、`[[<img onerror>]]`、`[x](javascript:…)`，
  预览全部转义为文本 / 不生成链接，`window.__xss` 从未被赋值。

## UX 复验补充（2026-11-12 第二轮，对照 lead 反馈）

| 项 | 处理 |
|---|---|
| **P1** 手机目录抽屉点笔记后不关闭（抽屉挂在 `#app` 外，SPA 重渲染不销毁，`html.no-scroll` 残留） | 抽屉改成「遮罩 + 侧栏面板」：面板内点任意 `a[href]` 立即 `close()`（不阻止 router 导航）；监听 `kb:navigate` 兜底；点遮罩（右侧 ~47px）也关闭；关闭时移除 `no-scroll` 并恢复焦点 |
| P2 新建顺序 | 有未保存改动时点「＋ 新建」：先弹「保存并离开 / 放弃修改 / 继续编辑」，确认后才打开新建路径弹层（`clearDirty` 避免紧接着再问一次） |
| P2 新建保存后标题 | 创建成功后立即把 H1 / `document.title` 从「新建：…」切成「编辑：…」，地址栏去掉 `?new=1`，不用刷新 |
| P2 手机锚点被顶栏遮 | 移动端 `heading { scroll-margin-top: 120px }`（顶栏实测 111px，TOC/锚点跳转标题落在 120px 处） |
| P2 桌面编辑字号 | `.edit-textarea` 桌面字号 13.5px → 16px（与手机一致） |
| P2 搜索纯标题命中卡片空白 | 无摘要时显示「只在标题里出现了「关键词」 · 父目录」，不再留空 |

复验（真接口 390×844 + 桌面 1280×800）：抽屉点笔记 → 抽屉关闭、`no-scroll` 解除、URL/H1 已跳转；点遮罩 → 关闭且不导航；
新建 `_webui2/标题更新测试` → 保存后 H1/标题/URL 同步更新，随后 DELETE，库回到 36 篇 / stale 0；
桌面编辑 textarea 16px；手机 TOC 跳转标题 top=120（顶栏 111）；搜索「压感」首条纯标题命中显示兜底文案。
