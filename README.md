# dsh-at-mention

`@` context references for the [DeepSeek Harness](https://github.com/deepseek-ai/dsh) web composer: one `@` source searches workspace files, the other references other sessions in the same workspace.

**English (default)** · [中文版](./README.zh.md)

## Overview

`dsh-at-mention` is a DeepSeek Harness plugin that adds `@`-mention capabilities to the web composer:

- **File mentions** — type `@` and a filename to search workspace files, then insert a live path-reference chip. The serialized form is the absolute path, read by the model from the current working tree under the existing filesystem policy.
- **Session mentions** — type `@` and a session title to find other sessions in the same workspace, then insert a session chip that serializes to the canonical `@[label](dsh-session:…)` mention.
- **Pre-send validation** — the client probes every reference before sending (session existence and file existence). A stale reference blocks the send with a visible error instead of being silently downgraded.
- **Model context** — at `agent/pre-step`, mentions are rewritten to readable `@label` spans. In the default snapshot mode, a bounded untrusted snapshot of each referenced session is injected before the user's message. In reference mode, only a live-reference notice is injected and the model reads on demand through a scoped `read_session` tool.

## Features

- Two `@` trigger sources in the web composer: `文件` (Files) and `会话` (Sessions).
- Debounced workspace file search with ripgrep, including `dsh-add-dir` added directories.
- Session candidate ranking with title matching, workspace scoping, recent-session suggestions, and duplicate-title disambiguation.
- Snapshot mode (default): up to `maxReferences` distinct session snapshots are injected before the user message, each bounded by `maxReferenceBytes`.
- Reference mode (`sessionReferenceMode: reference`): injects a live-reference notice and registers a per-agent `read_session` tool with paged reads.
- Explicit degradation: self-references, duplicates, overflow, and failed reads are surfaced as durable `plugin/notice` rows — never silently dropped.
- Clean effect-based registration for safe unload/HMR.

## Installation

### Prerequisites

- A DeepSeek Harness (`dsh`) environment with plugin support.

### Install from the plugin market (recommended)

The plugin is published to npm, so it can be installed directly through `dsh`:

```sh
dsh plugin --profile <name> add dsh-at-mention
dsh --profile <name> --dump-config
dsh --profile <name>
```

Replace `<name>` with your DeepSeek Harness profile name.

The bundle layer inserts one host plugin row (`id: at-mention`); the client half rides the `dsh.client` declaration in `package.json`, so no separate client installation step is required.

### Install from source (optional, for development/debugging)

If you need to build from source or modify the plugin:

```sh
git clone https://github.com/Lan-zk/dsh-at-mention.git
cd dsh-at-mention
pnpm install
pnpm build
dsh plugin --profile <name> add ./dsh-at-mention
dsh --profile <name> --dump-config
dsh --profile <name>
```

### Verify the installation

After adding the plugin, run `dsh --profile <name> --dump-config` and confirm that the `at-mention` plugin row is present. Then start DeepSeek Harness, open the web composer, and type `@` — you should see the `文件` and `会话` trigger groups.

## Usage

1. Open a session in the DeepSeek Harness web composer.
2. Type `@` in the input box.
3. Choose a group:
   - **Files (`文件`)**: continue typing a file name/keyword to search workspace files. Select a candidate to insert a live file-reference chip.
   - **Sessions (`会话`)**: continue typing a session title to search sessions, or leave the query empty to see the three most recent sessions. Select a candidate to insert a session-reference chip.
4. Send the message. Before sending, the plugin checks that every referenced file and session still exists. If a reference is stale, sending is blocked and a visible error is shown.
5. The model receives readable `@label` spans. In snapshot mode, bounded snapshots of referenced sessions are injected as additional context. In reference mode, the model can call `read_session` to page through referenced session history on demand.

> Note: the trigger group titles are currently hardcoded Chinese source names (`文件` / `会话`) because the upstream `slash.menu` locale namespace is single-owner; this is a known limitation.

## Configuration

All configuration is optional. Defaults are applied by Schemastery validation.

| Key | Default | Description |
| --- | --- | --- |
| `debounceMs` | `100` | File-search input debounce in milliseconds (client half). |
| `maxCandidates` | `20` | Per-group candidate cap (client half). |
| `fileSearch.maxResults` | `100` | Host-side search result cap. |
| `fileSearch.excludePatterns` | `[]` | Extra directory names excluded from search. |
| `fileSearch.includeAddedDirs` | `true` | Fan the search out across `dsh-add-dir` added directories. |
| `sessionScope` | `workspace` | Candidate/read scope: `workspace` (same cwd) or `all` (every local session). |
| `sessionReferenceMode` | `snapshot` | `snapshot` (eager) or `reference` (lazy `read_session`). |
| `maxReferenceBytes` | `65536` | UTF-8 byte budget per referenced-session snapshot. |
| `maxReferences` | `3` | Maximum distinct referenced sessions per message (hard cap is 3). |
| `readPage.maxBytes` | `65536` | Lazy `read_session` page byte budget. |
| `readPage.maxTurns` | `20` | Lazy `read_session` page turn cap. |

## HTTP surface

The host half exposes three read-only routes for the client half:

- `GET /api/at-mention.search-files?cwd=<…>&q=<…>` → `{ files: [{ abs, rel, root }], truncated }`
- `GET /api/at-mention.resolve-session?id=<…>` → `{ exists }`
- `GET /api/at-mention.stat-file?cwd=<…>&path=<…>` → `{ exists }`

## Development

```sh
pnpm install
pnpm build
pnpm test
```

Run `pnpm build` before `pnpm test`: the built-bundle smoke test mounts `lib/index.js` and skips itself when the artifact is absent.

## License

[MIT](./LICENSE) (if a LICENSE file is present; otherwise the `license` field in `package.json` applies).
