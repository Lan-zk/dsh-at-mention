# dsh-at-mention

**中文版** · [English](./README.md)

`dsh-at-mention` 是一个 DeepSeek Harness 插件，为 Web 编辑器提供 `@` 上下文引用能力：一个 `@` 来源搜索工作区文件，另一个 `@` 来源引用同一工作区中的其他会话。

## 功能

- 在 Web 编辑器中提供两个 `@` 触发源：`文件` 和 `会话`。
- 基于 ripgrep 的防抖工作区文件搜索，支持 `dsh-add-dir` 添加的目录。
- 会话候选排序：标题匹配、工作区范围、最近会话推荐、重复标题消歧。
- 快照模式（默认）：发送前注入最多 `maxReferences` 个不同会话的受限快照，每个快照受 `maxReferenceBytes` 限制。
- 引用模式（`sessionReferenceMode: reference`）：仅注入 live-reference 提示，并注册按会话作用域的 `read_session` 工具，按页读取。
- 显式降级：自引用、重复、超限、读取失败都会生成持久的 `plugin/notice` 提示行，绝不静默丢弃。
- 基于 effect 的注册方式，支持安全卸载与 HMR。

## 安装

### 前置要求

- 支持插件的 DeepSeek Harness（`dsh`）环境。
- [pnpm](https://pnpm.io/) 和 Node.js（用于从源码构建）。

### 从源码安装

```sh
git clone https://github.com/Lan-zk/dsh-at-mention.git
cd dsh-at-mention
pnpm install
pnpm build
dsh plugin --profile <name> add ./dsh-at-mention
dsh --profile <name> --dump-config
dsh --profile <name>
```

将 `<name>` 替换为你的 DeepSeek Harness 配置名称。

插件通过 `cordis.patch.yml` 注入一个 host 插件行（`id: at-mention`）；客户端部分由 `package.json` 中的 `dsh.client` 声明自动加载，无需单独安装。

### 验证安装

执行 `dsh --profile <name> --dump-config`，确认存在 `at-mention` 插件行。然后启动 DeepSeek Harness，打开 Web 编辑器并输入 `@`，应能看到 `文件` 和 `会话` 两个触发分组。

## 使用方法

1. 在 DeepSeek Harness Web 编辑器中打开一个会话。
2. 在输入框中输入 `@`。
3. 选择分组：
   - **文件**：继续输入文件名或关键词搜索工作区文件，选择候选项插入文件引用 chip。
   - **会话**：继续输入会话标题搜索会话，或留空查看最近 3 个会话，选择候选项插入会话引用 chip。
4. 发送消息。发送前插件会检查所有引用的文件和会话是否仍然存在；如果引用失效，会阻止发送并显示可见错误。
5. 模型会收到可读的 `@label` 文本。在快照模式下，引用会话的受限快照会作为额外上下文注入；在引用模式下，模型可按需调用 `read_session` 分页读取被引用会话的历史。

> 注意：触发分组标题目前硬编码为中文（`文件` / `会话`），因为上游 `slash.menu` locale 命名空间是单属主；这是已知限制。

## 配置

所有配置均可选，默认值由 Schemastery 校验填充。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `debounceMs` | `100` | 文件搜索输入防抖毫秒数（客户端）。 |
| `maxCandidates` | `20` | 每个分组的候选项数量上限（客户端）。 |
| `fileSearch.maxResults` | `100` | 服务端搜索结果数量上限。 |
| `fileSearch.excludePatterns` | `[]` | 额外排除的目录名。 |
| `fileSearch.includeAddedDirs` | `true` | 是否搜索 `dsh-add-dir` 添加的目录。 |
| `sessionScope` | `workspace` | 候选/读取范围：`workspace`（同工作目录）或 `all`（所有本地会话）。 |
| `sessionReferenceMode` | `snapshot` | `snapshot`（急切快照）或 `reference`（延迟 `read_session`）。 |
| `maxReferenceBytes` | `65536` | 每个被引用会话快照的 UTF-8 字节预算。 |
| `maxReferences` | `3` | 每条消息最多引用的不同会话数（硬上限为 3）。 |
| `readPage.maxBytes` | `65536` | 延迟 `read_session` 每页字节预算。 |
| `readPage.maxTurns` | `20` | 延迟 `read_session` 每页轮次上限。 |

## HTTP 接口

服务端为客户端提供三个只读路由：

- `GET /api/at-mention.search-files?cwd=<…>&q=<…>` → `{ files: [{ abs, rel, root }], truncated }`
- `GET /api/at-mention.resolve-session?id=<…>` → `{ exists }`
- `GET /api/at-mention.stat-file?cwd=<…>&path=<…>` → `{ exists }`

## 开发

```sh
pnpm install
pnpm build
pnpm test
```

请先运行 `pnpm build` 再运行 `pnpm test`：构建产物冒烟测试会挂载 `lib/index.js`，如果构建产物不存在会跳过自身。

## 许可证

[MIT](./LICENSE)（如果仓库中存在 LICENSE 文件；否则以 `package.json` 中的 `license` 字段为准）。
