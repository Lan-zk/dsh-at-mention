# dsh-at-mention 交互与 UI 对抗性审查报告

- 审查对象：`dsh-at-mention`，commit `b0c70e5`（tag `v0.1.5`）
- 审查日期：2026-08-18
- 审查范围：`@` 文件/会话引用的候选菜单、插入、草稿呈现、删除/导航、复制粘贴、发送前校验、宿主消费与相关测试
- 审查方法：
  1. 静态审查本仓库全部 `src/` 与 `tests/`；
  2. 对照上游 `deepseek-harness` 实际源码（`ui-input-trigger`、`ui-conversation` InputBar/facade/machine、React 18.3.1 内部实现）逐条验证行为；
  3. git 对比 `v0.1.4 → v0.1.5`（commit `48296f4`「render at-mention as plain text with atomic editing」）定位回归；
  4. jsdom 实测复现 React 受控 textarea 的删除传播问题；
  5. 实跑 `pnpm run build` 与 `pnpm test`。

---

## 1. 结论摘要

1. **你报告的三个问题全部属实**，且是同一架构决定的直接后果：
   - 问题 1（文件带出整条绝对路径、中文乱码）与问题 2（会话带出 sessionID）：**元数据载荷被当作普通可见文本渲染**。`U+2063` 只是两个“分隔符”是零宽字符，分隔符之间的 `f:%2F…` / `s:…` 载荷是完全可见的普通字符。于是输入框里会真实显示 `@文件名.md⁣f:E%3A%5C%E9%A1%B9…⁣`、`@会话名⁣s:session-id⁣`（⁣ 处为零宽分隔符）。
   - 问题 3（整段 @ 删除不掉，刷新才消失）：`atomic.ts` 直接执行 `el.value = next` 再派发 `input`。宿主的 composer 是 React 受控 `<textarea value={draft}>`；React 18 会拦截 `value` 的赋值并把“已追踪值”同步更新，导致后续 `input` 事件被判定为“值没有变化”，**onChange 根本不会触发**，机器里的草稿状态从未更新。而宿主输入框的字形由 React 状态渲染的 backdrop 层绘制（textarea 自身文字透明），所以视觉上 @ 字符串一直留在框内。
2. **v0.1.5 引入了一次功能性回退**：从 chip（`ReferenceInsert` + `codec`）切换成纯文本后，**发送前探活（resolve-session / stat-file）完全失效**，README 与 DESIGN 承诺的“失效引用阻断发送并保留草稿”不再成立。
3. **架构级结论**：在 `<textarea>` 的纯文本里做“可见 label + 隐藏元数据”是一条走不通的路——**textarea 无法只对某个子串隐藏渲染**。上游的 chip 管线（`U+FFFC` 占位符 + occurrence 表）天然提供原子删除、撤销、复制粘贴投影和发送前 `codec.serialize` 探活，v0.1.4 已经用对过。**最高优先级修复是回退到 chip 路径**，而不是继续修补纯文本方案。

严重度共 4 级：**P0**（核心交互被破坏/用户直接可见的功能损坏）、**P1**（主要 UX/可访问性/功能回归）、**P2**（一般质量问题）、**P3**（打磨项）。

---

## 2. 问题总表

| ID | 级别 | 领域 | 位置 | 一句话描述 | 对应你报告的问题 |
|---|---|---|---|---|---|
| A-01 | P0 | 草稿呈现 | `src/client/reference-format.ts:18,49-59` | 隐藏载荷实际可见，绝对路径 / sessionID / 百分号编码全部显示在输入框 | 问题 1、2（含乱码） |
| A-02 | P0 | 删除交互 | `src/client/atomic.ts:51-58` | 直接写 `el.value` 绕过 React 受控值追踪，机器状态不更新，删除视觉上无效 | 问题 3 |
| A-03 | P0 | 功能回归 | `src/client/index.ts:112-114,168-170` | 纯文本路径没有 `codec`，发送前会话/文件探活被静默移除 | — |
| B-01 | P1 | 信息呈现 | `src/client/index.ts:111`；`candidates.ts:88-90,152-153` | 菜单里的消歧后缀/根别名在插入后丢失，同名会话/文件在输入框里无法区分 | — |
| B-02 | P1 | 产品语义 | `src/client/index.ts:169` | 文件可见 label 是相对路径而非文件名，与你“只要文件名”的预期不符 | 问题 1 的第二层 |
| B-03 | P1 | 复制粘贴 | `src/client/index.ts`（无 codec） | 复制 @ 引用会把 `f:`/`s:` 载荷一起复制出去；粘贴不还原为引用 | — |
| B-04 | P1 | 数据完整性 | `src/client/reference-format.ts:35` | 用户可编辑可见 label 而保持旧载荷，label 与真实目标失配 | — |
| B-05 | P1 | 删除语义 | `src/client/atomic.ts:73-89` | 选区横跨两个引用时，会把引用之间的正常文字一起删掉 | — |
| B-06 | P1 | 键盘交互 | `src/client/atomic.ts:102-137` | Ctrl/Alt+Backspace/Delete、Ctrl+方向键被劫持，破坏系统级文本编辑习惯 | — |
| C-01 | P1 | 样式隔离 | `src/client/styles.ts:52-68` | `[data-decoration='chip']` 规则作用于所有插件的 chip，不只是本插件 | — |
| C-02 | P1 | 可访问性 | `src/client/styles.ts:71-79` | 硬编码 `#689efe` / `#9e8cfe`，浅色背景对比度 2.65:1 / 2.75:1，不满足 WCAG AA | — |
| C-03 | P1 | Windows | `src/client/candidates.ts:105-121` | 相对路径按 `/` 切分；Windows 返回 `\`，导致段前缀匹配、目录深度、父目录描述全部失效 | — |
| C-04 | P2 | 视觉正确性 | `src/client/atomic.ts:197-224` | backdrop 用 `textContent` 计算偏移；前方存在其他来源 chip 时偏移错位，颜色涂错位置 | — |
| C-05 | P2 | 反馈 | `src/client/index.ts:138-155` | 宿主返回 `truncated` 被完全忽略，结果被截断无任何提示 | — |
| C-06 | P2 | 反馈 | `src/client/index.ts:133-135` | cwd 缺失时文件源静默返回空数组，无错误候选 | — |
| D-01 | P1 | 文档/测试 | `README.md`、`DESIGN.zh.md` | 文档仍描述 chip + 发送前探活；实现已是纯文本且无探活；测试没有覆盖 atomic.ts | — |
| D-02 | P2 | 健壮性 | `src/consumer.ts:62-75` | 注释声称“单消息 try/catch 隔离”，实现没有；一条坏消息可炸掉整个 pre-step | — |
| D-03 | P2 | 维护性 | `src/client/reference-format.ts` 与 `src/shared/reference-format.ts` | 两份逐字重复，只有 shared 副本有测试，漂移风险 | — |
| D-04 | P2 | 死代码 | `src/client/host-api.ts:49-63`、`src/client/uri.ts` | `resolveSession` / `statFile` / URI 编码器已无人调用，迁移不完整 | — |
| D-05 | P2 | 测试可移植 | `tests/api.test.ts`、`tests/search.test.ts` | Windows 上 `pnpm test` 7 项失败（`rg.exe` 断言、POSIX 路径硬编码） | — |
| D-06 | P3 | 文案 | `src/consumer.ts:200-211` 等 | 中文产品里的降级/溢出提示为英文 | — |
| D-07 | P3 | 安全加固 | `src/api.ts:112-148` | 错误消息原样回传（可能含本机绝对路径）；搜索路由无节流 | — |
| D-08 | P3 | 工具呈现 | `src/tool.ts:206,216-218` | `read_session` 的 label/标题显示 session id 而非会话标题 | — |

---

## 3. 三个用户报告问题的根因链

### 3.1 问题 1 + 问题 2：隐藏载荷其实是可见文本（A-01）

**证据**

`reference-format.ts` 的“隐藏后缀”定义为：

```ts
export const REF_MARK = '\u2063'                       // 只隐藏这一个字符本身
export function encodeFileReference(rel: string, abs: string): string {
  return `@${rel}${REF_MARK}f:${encodeURIComponent(abs)}${REF_MARK}`
}
export function encodeSessionReference(label: string, id: string): string {
  return `@${label}${REF_MARK}s:${encodeURIComponent(id)}${REF_MARK}`
}
```

`U+2063 INVISIBLE SEPARATOR` 是零宽字符，但它只是**分隔符**。两个分隔符之间的 `f:<payload>`、`s:<payload>` 是普通 ASCII 字符，宿主 InputBar 会把整个草稿逐字渲染进 `[data-input-backdrop]`（`InputBar.tsx:568-627,698`），插件自己的 `decorateBackdrop` 只给 `[start, visibleEnd)` 的 label 上色（`atomic.ts:207-225`），**载荷不在任何隐藏机制内**。

**实际插入的草稿文本（实测）**

```
@设计文档.md⁣f:E%3A%5C%E9%A1%B9%E7%9B%AE%5C%E8%AE%BE%E8%AE%A1%E6%96%87%E6%A1%A3.md⁣
@需求讨论⁣s:session-abc123⁣
```

（⁣ 表示零宽分隔符）视觉上就是：

- 文件：`@设计文档.md f:E%3A%5C%E9%A1%B9…`——整条百分号编码的**绝对路径**露在输入框里；中文路径编码成 `%E9%A1%B9%E7%9B%AE`，就是你看到的“乱码”。
- 会话：`@需求讨论 s:session-abc123`——**sessionID 露在输入框里**。

**影响**：输入框信息污染、认知负担、草稿持久化与上下文计数都被这段载荷撑大；这也是 B-03（复制粘贴泄漏）的上游原因。

**修复方向**：无法在 textarea 内隐藏子串。回退 chip 路径后，`ref` 存进 occurrence 表、草稿里只有 `U+FFFC` 占位符，label 由 backdrop 单独渲染，问题从机制上消失。

### 3.2 问题 3：删除不生效，刷新才消失（A-02）

**证据**

`atomic.ts` 的删除实现：

```ts
function commitEdit(el: HTMLTextAreaElement, next: string, caret: number): void {
  el.value = next                       // ← 直接赋值
  setSelection(el, caret)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
}
```

宿主的 composer 是 React 18 受控组件：

```tsx
<textarea ... value={draft} onChange={onChange} />   // InputBar.tsx:699-702
```

React 18.3.1 对受控表单元素安装了 value tracker（`react-dom.development.js`）：

- `trackValueOnNode`（1631 行）用 `Object.defineProperty` 包住 `value`，**任何 `el.value = x` 的赋值都会同步更新 tracker 的 `currentValue`**；
- `updateValueIfChanged`（1698 行）比较 tracker 值与 DOM 值，二者相等 ⇒ 返回 false；
- `getInstIfValueChanged`（7811 行）→ `getTargetInstForInputOrChangeEvent`（7933 行）据此决定**不派发 onChange**。

所以：DOM 值被改掉了，但机器草稿（`draft`）从未更新。宿主的可见文字由 React 状态渲染的 backdrop 绘制（textarea 自身 `color: transparent`，见 `InputBar.module.css:216`），因此用户看到 @ 字符串原封不动；只有刷新让 composer 状态重建才会消失。

**jsdom 实测复现**（React 18.3.1 + jsdom 29，完整脚本见附录 A）：

```json
// 直接 el.value = ''（插件当前做法）
{ "domValue": "", "state": "@文件.txt⁣f:E%3A%5Cpath⁣ ", "changes": [] }

// 使用原型 setter 绕过 React 的 value 拦截（临时修复做法）
{ "domValue": "@文件.txt⁣f:E%3A%5Cpath⁣ ", "state": "", "changes": [""] }
```

**影响**：整个 @ 引用无法通过键盘删除（Backspace/Delete/选区删除全走 `commitEdit`），是本次审查最严重的交互损坏。

**临时修复**（如果暂时无法回退 chip）：

```ts
const nativeSet = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
nativeSet?.call(el, next)   // 绕过 React 的实例级 value 拦截
el.dispatchEvent(new InputEvent('input', { bubbles: true, ... }))
```

但这只能救删除；可见载荷问题仍无法在纯文本方案内解决，因此**正式修复仍应回退 chip**。

### 3.3 附带确认：发送前探活已经失效（A-03）

v0.1.4 的 chip 路径中：

- 会话 `codec.serialize` 先 `resolveSession`，失败抛错 → `sinkSerialized` 阻断发送、保留草稿；
- 文件 `codec.serialize` 先 `statFile`，失败同理。

v0.1.5 改成 `onPick` 返回 `{ text }`（`client/index.ts:112-114,168-170`）后：

1. 草稿里没有 occurrence；
2. 上游 `SessionInputShell.sinkSerialized`（`facade.ts:416-449`）对 `occurrences.length === 0` 直接发送原文，没有任何 `codec` 可执行；
3. `resolveSession` / `statFile`（`host-api.ts:49-63`）成为死代码，这两条探活路由只剩测试在调。

**结果**：文件已删除/移动、会话已删除时，消息照样发送；README 声称的“Pre-send validation … stale references block the message with a visible error”不再成立。会话引用尚有余下的宿主降级提示，文件引用则直到模型读取失败才暴露。DESIGN §4.3/§7 的承诺同步失效。

---

## 4. P1 级发现详情

### B-01 消歧信息在插入时丢失

- `sessionCandidates` 对同名会话生成 `未命名 · 123456`（`candidates.ts:88-90`），但 `sessionSource.onPick` 拿到 id 后重新用 `titleOf(ctx, id)` 取裸标题插入（`client/index.ts:108-114`）。用户选中“未命名 · 123456”，输入框却是 `@未命名`。
- `fileCandidates` 对跨根同名文件生成 `same.ts · lib`（`candidates.ts:152-153`），但 `onPick` 插入的是 `file.rel`（`client/index.ts:168-170`），两个 `same.ts` 在输入框里长得一模一样。

**修复**：插入的 label 直接用 `candidate.name`（菜单里用户实际选中的文本），不要回查裸标题；chip 路径下把消歧后的 label 存进 `ReferenceInsert.label`。

### B-02 文件可见 label 的语义与你的预期不一致

设计（DESIGN §4.2）规定文件 label = 工作区相对路径；你期望只显示文件名。现状：`@src/deep/config.ts` + 可见载荷。即使载荷修好，输入框仍不是“单单文件名”。建议产品裁定：**草稿/菜单主 label 显示 basename，目录放 description**；重名时按根别名或父目录消歧；模型侧仍使用绝对路径。无论选哪种，都需要与 DESIGN/README 一起更新。

### B-03 复制 / 剪切 / 粘贴泄漏载荷

纯文本路径没有 occurrence，宿主的 `onCopyOrCut`（`InputBar.tsx:368-390`）对“无 chip 触及”的选区走原生复制，用户复制一个 @ 引用得到的是含 `⁣f:%2F…⁣` 的整段文本。粘贴到别的应用会泄漏本机绝对路径 / sessionID；粘贴回 composer 也不会像 chip 那样经 `clipboardText` 还原。

**修复**：chip 路径的 `clipboardText`（会话 `@标题`、文件 `@文件名` 或相对路径）直接解决。

### B-04 label 与载荷可被编辑失配

`PATTERN = /@([^\u2063\n]*?)\u2063([fs]):([^\u2063]+)\u2063/gu` 把 label 当作可变文本。用户只要能在 label 内编辑（拖选部分文本后输入、IME 替换等），新 label 就会带着旧载荷继续被宿主解析：会话快照使用**新 label + 旧 sessionId**，文件同理。这是一个“所见非所指”的数据完整性缺口。chip 路径中 ref 独立于 label，编辑要么整删要么不动，无此问题。

### B-05 跨引用选区删除会吞掉中间文本

`expandToReferences` 对与选区相交的引用取 `min(start)` / `max(end)` 后整段切片（`atomic.ts:73-89,117-119`）。例如 `A @x B @y C`，从 @x 内拖选到 @y 内按 Delete，`B` 也会被删除。预期行为是：只把相交的引用各自扩展为整块，引用之间的普通文本保持不动（除非被选区直接覆盖）。

### B-06 修饰键组合被劫持

`handleKeyDown` 处理 Backspace/Delete/Arrow 时没有检查 `ctrlKey / metaKey / altKey`（`atomic.ts:91-138`）：

- Ctrl+Backspace / Ctrl+Delete（删除整词）在引用内变成删除整个引用；
- Ctrl+←/→（按词跳转）被改成跳到引用边界。

这会破坏宿主 composer 的用户已有肌肉记忆。修复：仅在无修饰键（或仅 Shift）时接管；其余组合全部放行给浏览器。

### C-01 样式泄漏到其他插件的 chip

`styles.ts:52-68` 的 `[data-composer-card] [data-decoration='chip'] > span` 和 `[data-invalid]` 规则没有本插件标识。当前版本本插件已不产生 chip，但只要上游/其他插件使用 chip（chip 管线仍完整存在，任何 `ReferenceInsert` 来源都会命中），这些规则就会**改写它们的 chip**，包括强制 `opacity:1`。注释说“不 restyle 无关来源”，但选择器做不到这一点。

**修复**：纯文本方案下直接删除这些 chip 规则；回退 chip 后，需要上游给 chip DOM 暴露 `data-source` 才能安全限定范围，否则不要全局改 chip 外观。

### C-02 硬编码颜色在浅色主题下对比度不足

实测 WCAG 对比度（白底）：

| 颜色 | 用途 | 白底对比度 | 是否 AA |
|---|---|---|---|
| `#689efe` | 文件引用 | 2.65:1 | ✗（需 ≥4.5） |
| `#9e8cfe` | 会话引用 | 2.75:1 | ✗ |

且完全不走 `--dsw-alias-*` 主题令牌。建议使用宿主主题色，或加深文字色 / 增加底色，保证明暗主题均 ≥4.5:1。

### C-03 Windows 路径导致文件排序与描述失效

`pathScore` / `depthOf` / `dirOf` 全部按 `/` 切分（`candidates.ts:105-121`）。Windows 上 `toDisplayPath` 返回 `src\deep\config.ts`：

- `lastIndexOf('/')` 为 -1 ⇒ “路径段前缀”永远不命中；
- `split('/')` 得到 1 段 ⇒ 深度恒为 0；
- `dirOf` 恒为 undefined ⇒ 描述里不显示父目录。

于是 Windows（你的运行环境）上文件候选的“段前缀 > 深度”排序退化成仅首段前缀 + 修改时间，且描述信息缺失。修复：显示层统一把 `\` 规范化为 `/`（或让宿主 `toDisplayPath` 直接输出 `/` 分隔的 rel）。

---

## 5. P2 / P3 发现速览

- **C-04 backdrop 偏移（P2）**：`decorateBackdrop` 以 `container.textContent` 计算偏移，而草稿中的 chip 在 backdrop 里渲染成 label 文本（长度≠1）。前方一旦出现其他来源的 chip，后续引用颜色会涂错位置。应以 textarea 的实际 `value` 为坐标源，或放弃自定义 backdrop 装饰。
- **C-05 `truncated` 被忽略（P2）**：宿主 `maxResults=100`、客户端 `maxCandidates=20`，搜索经常被截断，但客户端丢弃 `data.truncated`，用户不知道还有更多结果。建议在候选末尾追加“结果过多，请细化关键词”提示行。
- **C-06 cwd 缺失静默（P2）**：`cwdOf` 返回 undefined 时文件源直接 `return []`，菜单里文件组凭空消失且无解释。应返回一条错误候选或可见说明。
- **D-02 消费器缺少逐消息隔离（P2）**：`consumer.ts:62-75` 的循环没有任何 try/catch，与模块注释“单条 try/catch 隔离”及 DESIGN §6.1 不符；一条异常消息即可让整个 pre-step 失败。
- **D-03 双份 `reference-format.ts`（P2）**：`src/client/` 与 `src/shared/` 逐字重复；`tsconfig.client-tests.json` 只覆盖 shared 副本。建议改为单一源文件供两端打包。
- **D-04 死代码（P2）**：`resolveSession` / `statFile` / `client/uri.ts` 已无调用方，是迁移半成品的信号。
- **D-05 Windows 测试失败（P2）**：本机 `pnpm test` 75 例中 7 例失败——4 例 API 测试断言 `argv[0].endsWith('rg')`（Windows 实为 `rg.exe`），3 例路径测试硬编码 POSIX 分隔符。CI 若只跑 Linux 会掩盖平台差异（而你的真实环境是 Windows）。
- **D-06 英文提示（P3）**：溢出/降级/live 提示均为英文，与中文产品文案不一致。
- **D-07 错误回传（P3）**：500 响应把底层错误原样给浏览器（可能包含本机 ripgrep 绝对路径）；搜索路由无节流。
- **D-08 `read_session` 呈现（P3）**：`label: args.session_id`、`presentCall` 只显示 id，模型与用户看到的都是裸 id 而非会话标题。
- **打磨清单（P3）**：插入尾部空格导致“第一次 Backspace 删空格、第二次才删引用”；`Delete` 的 `inputType` 恒为 `deleteContentBackward`；点击恰在 `range.end` 时不选中整块（`atomic.ts:150`）；dispose 时不清除已注入的装饰 span、不防止重复注册导致 HMR 双监听；`--no-ignore` 与 DESIGN §5.2 的 ignore 描述不一致。

---

## 6. 架构结论与推荐修复方案

### 6.1 核心结论

> **在纯文本 textarea 里实现“隐藏元数据”是反模式。** 任何可见字符方案要么泄露（现状），要么依赖零宽编码（不可维护、不可访问、可被复制）。上游 chip 管线正是为解决“label 与 ref 分离、原子删除、粘贴投影、发送序列化”而存在，且 v0.1.4 已经正确使用过。

### 6.2 主修复：回退到 `ReferenceInsert` + `codec`（P0）

恢复 `v0.1.4` 的插入形态，并叠加本次审查的修正：

```ts
// 会话源 onPick（示意）
return {
  insert: {
    source: '会话',
    ref: id,
    label: candidate.name,               // 保留菜单里的消歧 label（B-01）
    clipboardText: `@${candidate.name}`,
  },
}
// codec
{
  clipboardText: ref => `@${titleOf(ctx, ref)}`,
  serialize: async (ref, signal) => {
    const label = titleOf(ctx, ref)
    if (!await resolveSession(ref, signal)) {
      throw new Error(`引用的会话已不可用（${label}），请移除该引用后重试`)
    }
    return formatSessionReferenceMention(ref, label)
  },
}

// 文件源 onPick（示意）
return {
  insert: {
    source: '文件',
    ref: JSON.stringify(file),
    label: candidate.name,               // basename 还是 rel，按 B-02 的产品裁定
    clipboardText: candidate.name,
  },
}
// codec.serialize：先 statFile(cwd, abs)，失败抛错阻断发送
```

随后：

1. 删除 `atomic.ts` 及其 document 级监听器 / MutationObserver / 自绘 backdrop（chip 的删除、导航、点击、撤销由上游 machine 原生处理）；
2. 删除 `src/client/reference-format.ts`，host 侧保留解析器仅用于**旧草稿兼容迁移**；
3. 恢复并强化 host 探活路由的客户端调用；
4. 同步更新 README / DESIGN 或明确记录偏离决策。

### 6.3 如果必须暂时保留纯文本方案

先做两件事止血：

```ts
// 1. 用原生 setter 绕过 React 的 value 拦截（A-02）
const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
descriptor?.set?.call(el, next)
el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: backward ? 'deleteContentBackward' : 'deleteContentForward' }))

// 2. 立即停止在可见文本中携带载荷（A-01 无 UI 解，只能改架构）
```

同时接受：该方案无法满足“输入框只显示文件名/标题”的要求，应排期尽快回到 chip 路径。

### 6.4 其余修复优先级

1. **P1 批次**：B-01/B-02（label 决策）、B-03（clipboardText）、B-04（label-ref 一致性）、B-05（选区扩展算法）、B-06（修饰键放行）、C-01（chip CSS 范围）、C-02（主题色 + 对比度）、C-03（Windows 路径规范化）。
2. **P2 批次**：C-04/C-05/C-06（视觉偏移、截断提示、cwd 提示）、D-02（逐消息隔离）、D-03/D-04（单源化、清死代码）、D-05（Windows 测试修复）。
3. **P3 批次**：D-06/D-07/D-08 与打磨清单。

---

## 7. 测试与 CI 建议（必须随修复落地）

1. **DOM 级交互测试**（当前完全没有，是 A-02 漏网的直接原因）：
   - jsdom + React 18 渲染受控 `<textarea value={draft}>`，模拟插入 → Backspace/Delete/选区删除，断言机器状态同步、视觉层更新；
   - 固定复现 A-02：`el.value = ''` 后断言 onChange 不触发，并断言原生 setter 方案触发。
2. **插入文本回归断言**：新增测试断言“任何插入产物不得在可见 label 之外包含 `f:`/`s:` 或百分号编码路径”（chip 方案下草稿只有占位符 + label 投影）。
3. **消歧回归**：同名会话/跨根同名文件插入后的可见 label 必须等于菜单候选 `name`。
4. **复制粘贴回归**：`clipboardText` 不含载荷；粘贴回 composer 经 paste-upgrade 还原引用。
5. **Windows 平台**：`tests/api.test.ts` 的 `endsWith('rg')` 改为 `['rg','rg.exe']`；`tests/search.test.ts` 使用 `path.posix` 或用平台感知断言；CI 增加 Windows runner。
6. **`pnpm test` 目标**：当前本机 75 例 68 通过 / 7 失败；修复后要求 Windows 与 Linux 双绿。

---

## 8. 验收清单（修复后逐项验证）

- [ ] 输入 `@` 选文件：输入框只显示 `@文件名`（或产品裁定的 label），无绝对路径、无 `f:`、无 `%` 编码；
- [ ] 输入 `@` 选会话：输入框只显示 `@会话标题`，无 `s:`、无 sessionID；
- [ ] 光标在引用内按 Backspace/Delete 一次删除整块；选中后删除同样生效；**无需刷新**；
- [ ] Ctrl/⌘+Z 撤销恢复引用；Ctrl/⌘+Arrow、Ctrl+Backspace 保持原生行为；
- [ ] 复制引用粘贴到外部应用只得到 `@label`；粘贴回 composer 还原为引用；
- [ ] 删除文件或会话后发送：发送被阻断，错误可见，草稿保留；
- [ ] 同名会话/同名文件在输入框中可区分；
- [ ] 浅色主题下两种引用颜色对比度 ≥4.5:1，暗色主题正常；
- [ ] Windows 上文件候选排序/目录描述正常；`pnpm test` 双平台通过。

---

## 附录 A：本次审查执行的验证命令

```powershell
# 构建与类型检查（通过）
pnpm run build

# 全量测试：75 例，68 通过，7 失败（Windows）
pnpm test
# 失败分布：
#  tests/api.test.ts  search-files execution ×4（rg.exe 断言）
#  tests/search.test.ts toDisplayPath / toAbsolutePath / toFileView ×3（POSIX 路径硬编码）
```

jsdom 复现 A-02 的关键输出：

```text
// 插件当前做法：el.value = next
{ "domValue": "", "state": "@文件.txt⁣f:E%3A%5Cpath⁣ ", "changes": [] }

// 原生 prototype setter 绕过 React value 拦截
{ "domValue": "@文件.txt⁣f:E%3A%5Cpath⁣ ", "state": "", "changes": [""] }
```

## 附录 B：关键证据索引

| 证据 | 位置 |
|---|---|
| 载荷编码（可见部分为普通字符） | `src/client/reference-format.ts:18,49-59` |
| 直接赋值 + 合成 input | `src/client/atomic.ts:51-58` |
| 纯文本 onPick，无 codec | `src/client/index.ts:108-114,164-171` |
| 探活函数已成死代码 | `src/client/host-api.ts:40-63` |
| React 受控 textarea | `deepseek-harness/.../InputBar.tsx:699-702,342-350` |
| 可见字形来自 React 渲染的 backdrop | `InputBar.tsx:568-627,698`；`InputBar.module.css:202-218`（textarea 文字透明） |
| React 18 value tracker 机制 | `react-dom.development.js:1631(trackValueOnNode),1698(updateValueIfChanged),7811,7933` |
| 纯文本路径不序列化、无探活 | `deepseek-harness/.../facade.ts:332-338,416-449` |
| chip 路径的原子删除/撤销/粘贴能力 | `deepseek-harness/.../machine.ts:201-209,293-304`；`InputBar.tsx:352-417` |
| v0.1.4 的正确实现被替换 | commit `48296f4`（对比 `76ea9bf`） |
| 文档承诺已失效 | `README.md` Features；`DESIGN.zh.md` §4.3、§7 |
