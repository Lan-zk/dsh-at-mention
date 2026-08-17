# dsh-at-mention

DeepSeek Harness Web 编辑器的 `@` 上下文引用插件：一个 `@` 搜索工作区文件，另一个 `@` 引用同一工作区中的其他会话。

**中文版** · [English](./README.md)

## 功能

- **文件引用** — 输入 `@` 和文件名，插入文件路径引用。
- **会话引用** — 输入 `@` 和会话标题，引用同一工作区中的其他会话。
- **发送前校验** — 发送前检查引用文件/会话是否存在，失效引用会阻止发送并提示。
- **模型上下文** — 将引用改写为可读的 `@label`；快照模式注入受限会话快照，引用模式提供 `read_session` 工具按需读取。

## 安装

插件需要 `webServer` 服务，请安装到 `web` profile：

```sh
dsh plugin --profile web add dsh-at-mention
dsh --profile web
```

## 卸载

```sh
dsh plugin --profile web remove dsh-at-mention
```

## 许可证

MIT
