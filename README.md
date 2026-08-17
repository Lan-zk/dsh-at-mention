# dsh-at-mention

`@` context reference plugin for the DeepSeek Harness web composer: one `@` source searches workspace files, the other references other sessions in the same workspace.

**English** · [中文版](./README.zh.md)

## Features

- **File mentions** — type `@` and a filename to insert a live file path reference.
- **Session mentions** — type `@` and a session title to reference another session in the same workspace.
- **Pre-send validation** — referenced files and sessions are checked before sending; stale references block the message with a visible error.
- **Model context** — mentions are rewritten to readable `@label` spans; snapshot mode injects bounded session snapshots before the user message, while reference mode exposes a scoped `read_session` tool.

## Install

The plugin runs in the `web` profile because it needs the `webServer` service:

```sh
dsh plugin --profile web add dsh-at-mention
dsh --profile web
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-at-mention
```

## License

MIT
