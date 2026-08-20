# dsh-at-mention 设计文档

> 插件定位：在 dsh Web 输入框中用 `@` 快速搜索并引用工作区文件，以及引用工作区下其他会话的内容。
> 本文是权威设计：每条结论标注宿主仓库出处，实现与评审以本文为准；本文与出处不一致时以出处为准。
> 版本：v1.1（2026-08-16，双审查修订，见 §1 裁定 4 与 §13）。

**权威次序**：`deepseek-harness` 源码 > 本设计 > 本地交接笔记。产品交互参照外部分析文档
`/Users/linzhikai/Documents/Codex/2026-08-16/new-chat/outputs/Codex-@-上下文引用能力分析.md`（下称《Codex 分析》）；
其中「当前版本实现细节」在本文中只作设计输入，不作产品承诺。

---

## 0. 定位与产品原则

`@` 不是文件搜索框，而是**统一结构化上下文选择器**：给当前消息挂上带类型、唯一标识、作用域与读取策略的上下文指针。
两条引用路径共享同一套 `@` 交互，与出厂已有的子智能体、动态插件 `@` 源并存。

六条产品原则（来自《Codex 分析》§一，逐条落到 dsh 实现）：

| 原则 | dsh 落点 |
|---|---|
| 显式相关性 | chip 取代自然语言描述路径/会话 |
| 结构化引用 | 触发器管线的 `ReferenceInsert` + `codec`：草稿持 chip（带唯一标识），发送时序列化为模型可见文本 |
| 延迟解析 | 选择时零内容；文件靠模型发送后按权限读取，会话靠发送时快照或按需工具读取（见 §6） |
| 统一入口 | 两条 `@` 源注册进既有管线，与 `subagent`/`cordis` 源并存（出处：[web-app 组合层](../deepseek-harness/packages/bundle/web-app/cordis.patch.yml)） |
| 权限不扩张 | 搜索路由只读；模型读文件走既有 fs 围栏；引用会话提及的文件不获得授权 |
| 上下文隔离 | 被引用内容以「不可信数据」注入，不合并会话、不覆盖当前指令 |

## 1. 需求与裁定记录

**原始需求**：输入框 `@` 快速搜索工作区下所有文件；`@` 引用工作区下其他会话的完整内容。

**裁定 1（2026-08-16）**：会话搜索只按**标题**匹配，不做正文/分支名/项目名搜索（v1）。
**裁定 2（2026-08-16）**：会话引用的**延迟读取模式（lazy）纳入设计**，与急切快照模式并列，实现排入 M5（见 §6）。
**裁定 3（2026-08-16）**：菜单组标题用**中文硬编码源名**（`文件`/`会话`），接受英文界面显示中文组名（原因见 §4.5）。
**裁定 4（2026-08-16，双审查合并）**：采纳技术规范审查与产品视角审查的合并修订，关键取舍：
lazy 模式复用上游封闭 form 词汇（`kind:'plugin', form:'notice'`，不新增 `'reference'`，见 §6.2）；
`read_session` 改 per-agent scoped 注册 + 会话白名单校验（正案）；
新增发送前引用探活（`resolve-session`/`stat-file`）→ 失效即**阻塞发送**；
超限降级升级为**转录可见**溢出提示行；文件组排序与多根聚簇显式化；重复标题消歧。
搁置项（依赖上游或无数据源）：第 4 个 chip 的客户端预标记、候选「已引用」禁用、最近文件推荐、预算实时可视化（见 §12）。
两份审查原文见 §13。

**措辞修正**：「完整内容」= **受限快照**。宿主 `session-reference` 机制读取的是被引用会话的**当前模型表面折叠视图**
（`readSurface` → `SessionSurfaceSnapshot`，出处：[session-query/types.ts](../deepseek-harness/packages/session-query/session-query/src/types.ts)），
默认每会话 64 KiB UTF-8 预算、每条消息最多 3 个引用（`DEFAULT_MAX_REFERENCE_BYTES = 65536`、`MAX_REFERENCES = 3`，
出处：[session-reference/config.ts](../deepseek-harness/packages/context/session-reference/src/config.ts)）。两值均可配（§5.3）。

## 2. 机制事实与出处（调研结论，实现前必须逐条核对）

| # | 结论 | 出处 |
|---|---|---|
| F1 | 触发器管线识别 `/` 与 `@`，词边界规则已内建（`user@host`、URL `/` 不触发）；`@` 在 `plain` 与 `claimed` 档均存活 | [detect.ts](../deepseek-harness/packages/client/ui-input-trigger/src/core/detect.ts)、[types.ts TriggerGuard](../deepseek-harness/packages/client/ui-input-trigger/src/types.ts) |
| F2 | 候选源契约：`candidates(session, { query, signal })` 异步、击键 supersede（`AbortSignal`）；`warm()` 作用域出生预热；`onPick` 返回 `{ text }`（纯文本）或 `{ insert: ReferenceInsert }`（chip）；`codec.serialize(ref, signal)` 在**发送时**逐个生成模型表示，**失败会阻塞发送且保留草稿** | [types.ts](../deepseek-harness/packages/client/ui-input-trigger/src/types.ts)、[facade.ts sinkSerialized](../deepseek-harness/packages/client/ui-conversation/src/client/input/facade.ts) |
| F3 | chip 路径有完整机器与测试（`insert-ref`、`paste-upgrade`、占位符序列化），但出厂四条源（`command`/`skill` 为 `/`，`subagent`/`cordis` 为 `@`，`cordis` 位于 `packages/extensions/ui-cordis`）全用纯文本路径——本插件的会话 chip 是该路径第一个生产消费者 | [input/machine.ts](../deepseek-harness/packages/client/ui-conversation/src/client/input/machine.ts)、[ui-subagent/index.ts](../deepseek-harness/packages/client/ui-subagent/src/client/index.ts)、[ui-cordis/index.ts](../deepseek-harness/packages/extensions/ui-cordis/src/client/index.ts) |
| F4 | 菜单按源分组渲染（每组一个标题行）；空结果组整体不渲染；只仲裁 ↑/↓/Enter/Esc，**无 Tab 仲裁**；`icon` 字段渲染为 span；高度钳制 320px | [MenuView.tsx](../deepseek-harness/packages/client/ui-input-trigger/src/client/MenuView.tsx)、[controller.ts ArbitrateKey](../deepseek-harness/packages/client/ui-input-trigger/src/client/controller.ts) |
| F5 | 组标题词典 `slash.menu` 归 `ui-input-trigger` 所有；locale 注册「命名空间+语言」单主，重复注册即抛错——树外插件无法注入新组标题翻译，未知 key 原样显示 | [ui-input-trigger/locales.ts](../deepseek-harness/packages/client/ui-input-trigger/src/client/locales.ts)、[locale/client/index.ts](../deepseek-harness/packages/client/locale/src/client/index.ts) |
| F6 | `session-reference` 包：`encodeSessionReferenceUri`/`formatSessionReferenceMention`（`@[label](dsh-session:…)`，纯函数可 client 端重实现）、`parseSessionReferenceText`（提取并渲染可读 `@label`）、`SessionReferenceResolver.prepare(agent, content, references, signal)`（读快照、按预算投影、产出不可信前缀 + `<referenced-sessions>` JSON 的 `additionalContext`，`source: { kind: 'session-reference', form: 'recall', references: [...] }`）。注意：`prepare` 对 content 只做克隆回显，**不负责**把 URI 改写成 `@label`——改写是消费器先 `parseSessionReferenceText` 的职责。该包**未挂任何 bundle，无生产消费方** | [session-reference/src/index.ts](../deepseek-harness/packages/context/session-reference/src/index.ts)、[uri.ts](../deepseek-harness/packages/context/session-reference/src/uri.ts) |
| F7 | 正确的消费缝是 `agent/pre-step` waterfall：payload `{ agent, messages, turn, step, signal }`，`next()` 后**改写 messages**；改写结果先落 `user/message` 日志再进模型请求——天然满足「模型可见即已记录」。`time-context` 是改写决策后追加消息的现成先例。⚠️ `ctx.on(…, { prepend: true })` 只决定**监听器执行顺序**（先执行、后处理他人结果），**不**改变 messages 数组内的插入位置——数组顺序由消费器显式构造 | [agent/runtime-types.ts](../deepseek-harness/packages/core/agent/src/runtime-types.ts)、[agent-loop/agent.ts preStep 与 turn](../deepseek-harness/packages/core/agent-loop/src/agent.ts)、[time-context/index.ts](../deepseek-harness/packages/context/time-context/src/index.ts) |
| F8 | Web 端 `session.prompt` 是封闭硬编码 `RpcMethodMap`，树外插件不可扩展远程方法；树外 client→host 通道的既定路径是 `webServer.register({ kind: 'exact', path, handler })` HTTP 路由（返回 disposer） | [apiproxy/api/rpc-map.ts](../deepseek-harness/packages/host/apiproxy/src/api/rpc-map.ts)、[dsh-add-dir/src/api.ts](../dsh-add-dir/src/api.ts) |
| F9 | 文件搜索后端复用 npm 包 `@deepseek-ai/dsh-tool-fs-search` 的 argv 纪律（`GLOB_VCS_EXCLUDES`、`RAW_OUTPUT_MAX_BYTES`/`SEARCH_*` 常量），但**不直接复用其 `runRipgrep`**：该包的 `resolveRgPath` 按进程 memoize，一次瞬时失败（安装中途、平台包暂缺）会粘住整个进程，且其启动失败包裹丢弃了 cause——本插件改为每次调用经 `createRequire` 现解析打包的 ripgrep 二进制（`@vscode/ripgrep` 为插件直接依赖）并通过 `subprocess` 服务直接 spawn，退出语义镜像核心（0=命中、1=无命中、其余报错且 message 携带 cause 链）；ripgrep 子进程需要 `subprocess` 服务 | [dsh-add-dir/src/shadow-search.ts](../dsh-add-dir/src/shadow-search.ts)（runRipgrep 复用先例）、[src/api.ts](src/api.ts) |
| F10 | client 会话列表 `sessions.list` 快照含 `id/title/displayTitle/cwd/parentId/running/blank/updatedAt` 等字段——标题候选零 RPC；第三方 client 插件**没有** `remote.sessions` 面（remotes 只 mount commands/goals 等五个 namespace，正文搜索必须走自有 HTTP 端点，v1 不做） | [runtime/sessions/service.ts](../deepseek-harness/packages/client/runtime/src/client/sessions/service.ts)、[api/remotes/src/client/index.ts](../deepseek-harness/packages/api/remotes/src/client/index.ts) |
| F11 | client 已能渲染 `session-reference` source 的注入消息：`contextProvenance` 识别为 `recall` 角色、标签为被引用会话标题（该分支只看 `kind`，不看 form） | [runtime/sessions/context-provenance.ts](../deepseek-harness/packages/client/runtime/src/client/sessions/context-provenance.ts) |
| F12 | 每 agent 的 scoped 注册先例：`ctx.on('agent/created', ({ agent }) => …)` + `agent.ctx.plugin({ inject: ['tools'], … })` | [dsh-add-dir/src/shadow-tools.ts](../dsh-add-dir/src/shadow-tools.ts) |

## 3. 功能语义

### 3.1 文件引用 = 实时路径引用（live path reference），不是快照

选择时零内容；发送后模型按**当前工作树**与权限读取。语义要点（写入 README 与用户可见文案）：
文件可能已被修改（读到的是新版本）；移动/删除后引用失效；引用目录由模型自行列举读取（v1 不支持目录，见 §4.4）。
发送前本插件做一次存在性探活（§5.2 stat 路由），把「点选时就已失效」的引用挡在发送之前；发送后的变化仍是 live 语义。

### 3.2 会话引用

两种读取策略（§6）：**急切快照（snapshot，v1 实现）**——发送前把受限快照注入请求；
**延迟读取（reference，M5 实现）**——只注入会话身份与读取指引，模型按需调用 `read_session` 工具。
两种模式都不合并会话、不切换 cwd、不建立父子关系、不给被引用会话的文件授访问权（《Codex 分析》§五.6 同构）。

## 4. 交互设计

### 4.1 触发与空态

- 触发：依赖管线既有词边界规则（F1），零工作。
- **空关键词（渐进式）**：文件组返回空候选（F4 空组自动隐藏）；会话组返回**最近 3 条**（`updatedAt` 降序，description 标注「最近」）。
  两源不对称是**有意为之**：会话天然有界且复用价值高，是合理的默认推荐；文件无 recency 数据源、全量展开不可行。
- 「输入关键词搜索」提示文案：菜单空态无文案槽（F4），v1 不渲染提示行，记为已知限制（§12）。

### 4.2 候选与排序

- **会话源**（`@` 源名 `会话`）：排除自身与 `blank` 行；按 `sessionScope` 过滤（§5.3）；
  组内排序：标题前缀匹配 > 子串匹配 > 更新时间降序；`description` 承载「运行中 / 子智能体」徽标与工作目录；
  同一工作区内**标题重复**的候选在 description 追加更新时间或短 id 消歧。
- **文件源**（`@` 源名 `文件`）：查询经 HTTP 搜索路由（§5.2）；`name` = 工作区相对路径；
  排序**显式定义**：精确前缀 > 路径段前缀 > 子串 > 目录深度升序 > 更新时间降序；多根场景同根结果聚簇；
  `description` = 根**别名**（主目录「主」、附加目录显示 basename，不做全路径截断），多根时必显（同名文件消歧）；
  不使用 emoji icon；类型信息由组标题与 description 承载，符合宿主 DESIGN.md 的“单蓝色信号、无第二强调色”原则；
  候选上限 `maxCandidates`（默认 20），菜单自身 320px 高度钳制（F4）。
- 防抖：默认 **100ms**（Config 可调），管线 `AbortSignal` 天然取消过期请求（F2）。
- **跨源全局混排（Codex top-8）不适用**：dsh 菜单按源分组渲染（F4），保留两组、组内排序。

### 4.3 拾取与序列化

| | dsh 本插件 | Codex（对照） |
|---|---|---|
| 会话 | chip（标签=标题）→ 发送时序列化 `@[标题](dsh-session:<uri>)` | `[@标题](thread://id)` |
| 文件 | chip（标签=相对路径）→ 发送时序列化**绝对路径**文本 | `[文件名](路径)` 节点 |

- 会话 URI 编码是纯函数（`base64url(JSON.stringify(sessionId))`，canonical 自校验），client 端重实现
  [uri.ts](../deepseek-harness/packages/context/session-reference/src/uri.ts)，零宿主往返。
  ⚠️ 宿主实现用 Node `Buffer`，浏览器端需用 `btoa`/TextEncoder 自实现并保证字节一致——跨端 round-trip 测试必做（§11）。
- **发送前探活（裁定 4）**：会话 chip 的 `serialize` 先经 `/api/at-mention.resolve-session` 校验会话仍存在，
  文件 chip 的 `serialize` 先经 `/api/at-mention.stat-file` 校验路径仍存在（均可取消、结果可短缓存）；
  失效则 `serialize` 抛错 → **发送被阻塞、草稿保留、错误可见**（F2/F3 契约语义，非静默降级）。
- `clipboardText`：会话 `@标题`、文件相对路径——复制粘贴经 `paste-upgrade` 恢复为 chip（F3）。
- 键盘：↑/↓/Enter/Esc 由管线仲裁（combobox 语义，焦点不离开输入框）；chip 的删除/粘贴沿用管线既有 chip 行为。

### 4.4 目录：v1 明确排除

Codex 的 Tab 下钻/Enter 插目录依赖 Tab 仲裁，dsh 管线不支持（F4），树外插件无法扩展。目录支持列为后续工作（§12）。

### 4.5 组标题本地化（裁定 3 的依据）

`slash.menu` 命名空间被 `ui-input-trigger` 单主占有（F5），树外插件无法注册 `session`/`file` 的组标题翻译；
未知 key 原样显示。**裁定：源名直接用中文 `'文件'` / `'会话'`**（产品文案中文优先），
英文界面显示中文组名记为已知限制。唯一性论证：现有 `@` 源为 `subagent`（packages/client/ui-subagent）与
`cordis`（packages/extensions/ui-cordis），`(trigger, name)` 不冲突。

### 4.6 发送后的转录

- 用户消息显示剥离后的可读文本（`@标题`，无 URI）。
- **类型与来源由上下文行承载，行内文本只是锚点**：快照模式前置 recall 行（F11 渲染、标注被引用标题）；
  reference 模式前置 notice 行（标注 live 引用）；文件引用是**绝对路径文本**（无 `@` 前缀），与行内 `@标题` 形态可辨。
  会话标题恰与文件名同形的极端情形由上下文行兜底。
- 溢出降级（§7）同样以转录可见行呈现，不做静默兜底。

## 5. 架构设计

### 5.1 包形态（照 `dsh-add-dir` 模板，出处：04-plugin-workflow §3）

- 包名 `dsh-at-mention`，`private`，单 npm 树外包；`exports` 含 `.`（host）与 `./client`。
- `package.json` 声明 `dsh.bundle: { "patch": "./cordis.patch.yml" }` 与 `dsh.client`（`platform: "web"`）；
  `cordis.patch.yml` 只贡献一行 `- insert: - id: at-mention / name: dsh-at-mention`。
- tsdown 双产物：`lib/index.js`（host ESM）与 `lib/client.js`（闭包工厂，注册 `window.__ModuleLoader__`）。
- 依赖增量（相对模板）：host 侧新增 `@deepseek-ai/dsh-session-reference`、`@deepseek-ai/dsh-tool-fs-search`、
  `@deepseek-ai/dsh-host-webserver`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-llm`（`createUserMessage`）；
  client 侧新增 `@deepseek-ai/dsh-client-ui-input-trigger`、`@deepseek-ai/dsh-client-runtime`（产品文案中文硬编码，无 locale 依赖）。
  版本对齐钉 `0.1.0-rc.7`（与已安装的 DSH CLI 一致）。
- **TS 程序分离（实现新增）**：`dsh-session`（host）与 `dsh-client-runtime`（client）对 `Context.sessions` 的声明合并互斥（host/client 双 aggregate，02 §7），
  一个 program 同时 import 两半会得到冲突类型（`list: () => Session[]`）。解法：`tsconfig.json`（host src+host tests）、`tsconfig.client.json`（client src）、
  `tsconfig.client-tests.json`（client 纯逻辑测试，排除 client/index.ts）三程序分查；类型产物分 `tsconfig.types.json` / `tsconfig.types.client.json` 两次 emit。

### 5.2 Host 半

```
apply(ctx)（inject: ['webServer']；可选读 ctx.get('subprocess')、ctx.get('addDirRegistry')、ctx.get('fs')）
├─ ctx.plugin(SessionReferenceResolver, { maxReferenceBytes, maxReferences })   // Service 挂载形态，F6；sessionQuery 缺失时经 inject 等待/响亮失败
├─ HTTP（全部 ctx.effect 注册、返回 disposer，F8 模式）
│   GET /api/at-mention.search-files?cwd=<…>&q=<…>
│    校验 cwd/q（非空字符串、长度上限、无 NUL）→ buildSearchArgv（F9 argv 纪律）+
│      自持 spawn：每调用现解析打包 ripgrep 二进制，经 subprocess 服务直接运行（不复用核心 runRipgrep，见 F9）
│    搜索根集合 = cwd + （includeAddedDirs 且 add-dir 在册时的全部目录）
│    默认排除 .git .hg .svn .next .pnpm-store .turbo .yarn node_modules build coverage dist（《Codex 分析》§四.2 清单）
│      + excludePatterns 追加；ripgrep 自身 ignore 规则照常生效
│    返回 { files: [{ abs, rel, root }], truncated }（受 maxResults 与核心搜索超时上限约束）
│    subprocess 缺失或打包 ripgrep 不可解析 → 503 { ok:false, error:{ code:'search-unavailable', message: 真实原因 } }
│    启动/运行失败 → 500，message 携带 cause 链（客户端菜单内直接可见）
│   GET /api/at-mention.resolve-session?id=<…>      // 会话存在性探活（sessionQuery 只读；返回 200 { exists }，服务缺失 → 503）
│   GET /api/at-mention.stat-file?cwd=<…>&path=<…>  // 文件存在性探活（fs stat 只读；path 必须落在搜索根集合内，否则 403；返回 200 { exists }）
└─ 会话引用消费器（§6）：ctx.on('agent/pre-step', handler, { prepend: true })，按 sessionReferenceMode 分派两臂
```

### 5.3 Config（Schemastery 校验，全部可调；出处：03-plugin-rules §5）

| 键 | 默认 | 约束 | 说明 |
|---|---|---|---|
| `debounceMs` | 100 | 50..500 | 文件搜索防抖 |
| `maxCandidates` | 20 | 1..50 | 每组候选上限 |
| `fileSearch.maxResults` | 100 | 1..500 | 搜索路由结果上限 |
| `fileSearch.excludePatterns` | `[]` | 每项非空字符串 | 追加排除 glob |
| `fileSearch.includeAddedDirs` | `true` | — | add-dir 目录 fan-out 开关 |
| `sessionScope` | `'workspace'` | `'workspace' \| 'all'` | 候选范围；`all` 三级排序：同 cwd > 无 cwd > 其他 cwd |
| `sessionReferenceMode` | `'snapshot'` | `'snapshot' \| 'reference'` | 会话读取策略（§6） |
| `maxReferenceBytes` | 65536 | 正整数 | 透传 resolver：单会话快照预算 |
| `maxReferences` | 3 | 1..3 | 透传 resolver（硬上限 3） |
| `readPage.maxBytes` | 65536 | 正整数 | lazy 工具单页字节预算 |
| `readPage.maxTurns` | 20 | 1..100 | lazy 工具单页 turn 数上限 |

### 5.4 安全

- 搜索/探活路由全部只读；参数在 wire 边界校验；`stat-file` 只接受搜索根集合内的路径；
  不触碰沙箱 mode，不改变 fs 围栏语义。
- 会话快照/读取全为只读；被引用内容一律经核心「untrusted snapshot」前缀（F6）。
- `read_session` 工具内做「调用方会话 cwd + sessionScope」白名单校验（§6.2，正案）。
- HTTP 路由、事件监听、源注册全部 effect 化，dispose 无残留（03-plugin-rules §2）。

## 6. 会话引用双模式

### 6.1 snapshot 模式（v1 实现）

`agent/pre-step` 消费器（F7 模式）：

```
async (payload, next) => {
  const decision = await next()                    // 永远委托，不短路（03-plugin-rules §4）
  if (decision.kind === 'reject' || payload.signal.aborted) return decision
  // 注意：{ prepend: true } 只决定监听器顺序（本消费器先执行、后处理他人结果，F7），
  // 与数组插入位置无关；以下在返回前显式构造 messages 数组顺序。
  for 每条 source.kind === 'user' 的消息（单条 try/catch 隔离，失败按 §7 降级，不炸轮次）:
    readableText = 对每个 text block 跑 parseSessionReferenceText 得到的渲染文本
    无引用 → 原样
    有引用 → resolver.prepare(agent, content, references, payload.signal)   // prepare 只产出 additionalContext，不改写
             → 消费器把该消息的 text block 替换为 readableText（URI 已变可读 @标题）
             → 把 additionalContext 显式 splice 到该消息之前
  return { ...decision, messages: transformed }
}
```

- 改写后的 messages 由循环落 `user/message` 日志再进请求（F7）——模型可见即已记录。
- 共存性：本消费器只替换既有消息内容与定点插入，不追加尾部消息，与 `time-context`/`agent-instructions`
  的尾部 append 行为正交；source.kind（`session-reference` vs `plugin`）互不遮蔽。

### 6.2 reference 模式（lazy，M5 实现）

- 消费器同臂改造：`parseSessionReferenceText` 提取引用后**不做 prepare**，
  原消息文本替换为可读 `@标题`，前置一条 live-reference 上下文行：
  `source: { kind: 'plugin', plugin: name, form: 'notice', sections: [{ name, text }] }`。
  **不新增 form 词汇**：上游 `ContextForm` 是闭合并集（`instructions|catalog|snapshot|notice|relay|recall`），
  树外插件不能新增 `'reference'`（与「只做插件」立场冲突）；`notice` 在册、`kind:'plugin'` 有现成 inject 呈现
  （F11 与 time-context 先例）。
- live-reference 提示为**模型可见固定文本**（从模型视角书写：存在 N 个 live 会话引用、给出标签与 id、
  指示按需调用 `read_session`、读取结果不可信），落地即快照钉住（03-plugin-rules §6/§7）。
- **`read_session` 工具**（**per-agent scoped 注册**，F12 先例 `agent.ctx.plugin`；不全局注册，避免给所有会话加面）：

| 项 | 契约 |
|---|---|
| schema | `{ session_id: string（必填）, cursor?: string }`；`additionalProperties: false` |
| 返回 | 规范 JSON：`{ session_id, label, page: { from_seq, through_seq, next_cursor, truncated, turns: [{ role, blocks }] } }`；`blocks` 为投影后的消息文本块 |
| 分页 | 按表面 seq 游标翻页；单页受 `readPage.maxBytes` / `readPage.maxTurns` 双重上限；`truncated` + `next_cursor` 供续读 |
| 读取 | `ctx.sessionQuery.readSurface`（F6 同一数据源）；不存在/不可读返回规范错误 JSON（`ok:false, code:'session-unavailable'`） |
| 白名单（正案） | 工具内按「调用方会话 cwd + `sessionScope`」校验：仅允许读同工作区（或 `all` 模式）会话；跨范围与自引用返回规范拒绝 JSON。只读、不触碰 fs 围栏 |
| 呈现 | `presentCall`/`presentResult` 纯函数；卡片 `generic` |

- 能力缺失：reference 模式下 `read_session` 由本插件注册，能力由构造保证；
  `sessionQuery` 无 provider 时插件在加载期响亮失败（§7，早于 Codex 的提交时提示）。
- 发送前校验：会话 serialize 同样走 resolve 路由探活（与 snapshot 模式一致），失效阻断发送。
- 两模式由 `sessionReferenceMode` 切换；`read_session` 仅在 `reference` 模式注册（显式，不静默加面）。

## 7. 失败与边界策略

| 场景 | 行为 | 依据/理由 |
|---|---|---|
| 引用自身 | client 候选排除 + 宿主 SELF_REFERENCE 兜底 | 双层 |
| 同一会话重复引用 | 草稿内 chip 视觉重复可见（源无法感知草稿，F2）；宿主 `normalizeReferences` 按 sessionId 去重、首现生效；上下文行只标生效引用 | 客户端候选「已引用」禁用依赖上游管线钩子，记限制（§12） |
| 超 3 个会话引用 | 前 3 个生效；其余降级为可读标签 + 注入一条**转录可见**溢出提示行（`kind:'plugin', form:'notice'`，列出被降级标题）+ `logger.warn` | 管线无跨 chip 计数钩子（F2），client 端无法阻止；不做静默降级——提示行用户可见、模型可见、logged |
| 引用会话被删/不可读 | **发送前** serialize 经 resolve 路由探活 → 失效**阻塞发送**+可操作错误（F2/F3 语义）；宿主 READ_FAILED 兜底（竞态窗口内） | 探活把「罕见」前置为「可归因」 |
| 文件移动/删除 | **发送前** stat 探活 → 失效阻塞发送；发送后的变化是 live 语义（模型读取时自然失败，文档写明） | §3.1 |
| `sessionQuery` 无 provider | 插件 inject 等待/加载期响亮失败 | 03-plugin-rules §5，早于 Codex 的提交时提示 |
| `subprocess` 缺失 | 搜索路由 503；文件源在菜单内返回一条「文件搜索暂时不可用」候选（`onPick → 'handled'`，不插入） | 菜单内可见错误而非静默空态 |
| 权限 | `@` 不绕过沙箱；引用会话提及的文件不获授权 | 《Codex 分析》§五.6/§八 |
| 上下文隔离 | 快照/读取结果 = 不可信数据，不覆盖当前用户请求与 AGENTS.md | 核心 untrusted 前缀（F6） |

## 8. 与 Codex 的差异对照（写入 README Known Limitations 的依据）

| 维度 | Codex | 本插件 v1 | 原因 |
|---|---|---|---|
| 全局混排 top-8 | 是 | 否，分两组 | 管线按源分组（F4） |
| 目录引用/Tab 下钻 | 支持 | 不支持 | 管线无 Tab 仲裁（F4） |
| 会话内容时机 | 发送后按需（read_thread） | 发送前急切快照（lazy 为 M5） | 复用核心机制（F6/F7） |
| 超限行为 | 提交时阻止 | 前 3 + 转录可见提示行 | 无 client 端计数钩子（F2） |
| 提交前引用探活 | 无 | resolve/stat 探活、失效阻断发送 | 强化 live 语义的用户可归因性 |
| 会话搜索字段 | 标题+正文+分支+项目名 | 仅标题（裁定 1） | F10 无 `remote.sessions` |
| 空态提示文案 | 有 | 无（空组隐藏；会话组给 3 条「最近」推荐） | 菜单空态无文案槽（F4） |
| 组标题本地化 | — | 中文源名硬编码（裁定 3） | locale 单主（F5） |

## 9. 规则检查表映射（03-plugin-rules）

1. 插件形态：host/client 两半均为函数插件具名导出（照 dsh-add-dir）；`SessionReferenceResolver` 为服务包默认导出，经 `ctx.plugin` 以 Service 挂载形态安装。
2. 注册即副作用：路由/事件/源全部 effect 化；每个注册表有 HMR-safety 测试。
3. 依赖：`inject` 声明 `webServer`；`subprocess`/`addDirRegistry`/`fs` 用 `ctx.get`；依赖 Service Definition 不依赖提供方。
4. 事件：pre-step waterfall 恒 `next()`；`{ prepend: true }` 仅取监听器顺序（F7），数组插入顺序由消费器显式构造。
5. 配置：§5.3 全表 Schemastery 校验；错误配置响亮失败；组标题中文源名属 locale 单主约束下的被迫产品文案（F5），记入 Known Limitations。
6. 模型与日志：改写后消息 + 注入上下文落日志；live-reference 与溢出提示固定文本快照钉住。
7. 工具（M5）：`defineTool` 规范 JSON + `output.render`；`presentCall`/`presentResult` 纯函数；策略不进工具体；白名单校验在工具内执行。
8. 并发：结果上限（§5.3）；dispose 停稳；消费器单消息 try/catch 隔离（§6.1），异常不炸轮次。
9. 包卫生：`./invariant`、README（Model Experience + Known Limitations）、Agent Note、单换行结尾。

## 10. 里程碑

- **M1（已完成，2026-08-16）**：项目文件夹 + 本设计文档；骨架件（package.json / tsdown.config.ts / pnpm-workspace.yaml / cordis.patch.yml / tsconfig）+ git 初始化。
- **M2（已完成，2026-08-16）**：host 半 snapshot 模式——resolver 挂载、pre-step 消费器、search-files / resolve-session / stat-file 三条路由；单测 28 例全绿（URI 解析、预算与降级路径、路由校验、作用域校验、HMR 注册形态）。
- **M3（已完成，2026-08-16）**：client 半——两个 `@` 源（`会话`/`文件`：候选/防抖/排序/消歧/序列化/发送前探活/错误候选）+ client 端 URI 编码（`btoa` 替代 `Buffer`）；跨端 round-trip 与候选纯逻辑测试并入全量 44 例。
- **M4（已完成，2026-08-16，含交接项）**：组装快照测试（注入快照/降级提示/live 提示的持久化形态钉住）+ 构建产物冒烟（`tests/bundle.test.js` 挂载 `lib/index.js` 真服务组合，双模式）。
  **交接项（需用户环境）**：真实 API 冒烟与内置浏览器回归——`dsh plugin --profile web add .` → `dsh --profile web --dump-config` 验证层 → 启动后验证菜单分组/chip/转录/探活与三条 HTTP 路由。
- **M5（已完成，2026-08-16）**：lazy 模式——`read_session` scoped 工具（seq 游标分页、字节/turn 双上限、cwd 白名单、自引用/越界/不可读闭合错误）+ `form:'notice'` live 消费臂 + `sessionReferenceMode` 切换；live 提示文本快照钉住。

## 11. 测试计划（对齐 04-plugin-workflow §4）

- 单元：`parseSessionReferenceText` 与 client 端 URI 编码往返/坏 URI；**跨端 round-trip**（host `Buffer` base64url 与 client `btoa`/TextEncoder 字节一致，覆盖非 ASCII 与引号 sessionId）；
  候选筛选（自身/blank/scope/排序/重复标题消歧）；防抖与 supersede；HTTP 路由参数校验与上限（含 stat 的根集合内校验）；
  pre-step 改写（含多消息、混合 image block、abort、单条失败隔离）；发送前探活（404 → serialize 抛错 → 发送阻塞、草稿保留）；
  错误候选 `onPick → 'handled'` 不插入；HMR-safety（dispose 后路由/监听器/源无残留）。
- 组装快照（无密钥）：注入快照消息与溢出提示行的持久化形态（source/form/references/sections 字段）；lazy 提示文本；转录可重建性。
- 真实组合：仅测试用 `cordis.yml` 经 Loader 启动，真服务、假 LLM；验证 pre-step 链路与日志。
- Web 回归：内置浏览器验证菜单分组、chip 增删/粘贴、发送后转录呈现与错误反馈可见性。

## 12. 已知限制与后续工作

- 会话正文搜索（需自有 HTTP 端点 + `sessionQuery` 支撑，裁定 1 暂缓）。
- 目录引用与 Tab 下钻（依赖管线仲裁扩展，F4）。
- 菜单空态「输入关键词搜索」提示文案（依赖管线空态槽，F4）。
- 组标题英文界面显示中文（F5 单主约束；上游扩展后方可本地化）。
- **草稿感知缺失**：第 4 个会话 chip 的客户端预标记、候选「已引用」禁用、草稿内重复 chip 提示，均需上游管线提供草稿状态钩子（源不持有草稿，F2）；宿主端已兜底（去重/溢出提示行）。
- 无「最近文件」数据源：文件组空关键词保持空态（§4.1 理由）。
- 上下文预算不做实时可视化（预算经 recall 行与 README 说明）。
- `Ctrl+N`/`Ctrl+P` 键盘导航依赖管线仲裁扩展（F4）。
- 窄屏/触控目标尺寸为管线既有样式边界，本插件不覆盖。

## 13. 审查记录

- **技术规范审查**（2026-08-16，子代理）：F1–F12 逐条核对源码，全部成立（3 处措辞级修订已并入 F3/F6/F7）；
  03-plugin-rules 无必然违规；P1 三项（`{ prepend: true }` 语义、`read_session` 作用域、pre-step 与 time-context 共存）已按修改建议落文；
  P2 四项（`form:'reference'` 撞上游闭合词汇、client `Buffer` 替代、reference 模式能力校验、四源名）已落文。
- **产品视角审查**（2026-08-16，子代理）：P0 四项（重复引用无反馈、超限静默、转录类型歧义、标题坏数据）已按可行度落文——
  其中「客户端预标记/候选禁用」因草稿感知缺失（F2）搁置并记 §12，其余经「上下文行承载类型」「溢出提示行转录可见」「发送前探活阻断」「重复标题消歧」解决；
  P1 六项采纳五（空态理由写明、探活归因、错误可见化、文件排序显式化、lazy 词汇合规化），「最近文件推荐」因无数据源搁置。
- 搁置项统一记录于 §12；两份审查原文以本表为索引留存于工作区会话记录。
