# dsh-at-mention

`@` context references for the DeepSeek Harness web composer: one `@` source
searches workspace files, the other references other sessions in the same
workspace. The design lives in [DESIGN.zh.md](./DESIGN.zh.md).

## What it does

- `@` + keyword searches files across the workspace roots (the session cwd
  plus dsh-add-dir added directories) and inserts a live path reference chip;
  the serialized form is the absolute path, read by the model from the
  current working tree under the existing fs policy.
- `@` + keyword lists other sessions in the workspace (title match, same-cwd
  scope by default); picking inserts a session chip that serializes to the
  canonical `@[label](dsh-session:…)` mention.
- At `agent/pre-step`, mentions are rewritten to readable `@label` spans.
  In snapshot mode (default), a bounded untrusted snapshot of each referenced
  session is injected before the user's message (max 3 distinct sessions,
  64 KiB each by default). In reference mode (`sessionReferenceMode:
  reference`), only a live-reference notice is injected and the model reads
  on demand through the per-session `read_session` tool (paged, workspace-
  scoped).
- Before send, the client probes every reference (session existence, file
  existence) and blocks the send with a visible error when a reference is
  stale — a live reference is never silently downgraded.

## Install

```sh
dsh plugin --profile <name> add ./dsh-at-mention
dsh --profile <name> --dump-config
dsh --profile <name>
```

The bundle layer only inserts one plugin row (id: at-mention); the client
half rides the package.json `dsh.client` declaration.

## Config

| key | default | meaning |
|---|---|---|
| debounceMs | 100 | file-search input debounce (client half) |
| maxCandidates | 20 | per-group candidate cap (client half) |
| fileSearch.maxResults | 100 | host-side search result cap |
| fileSearch.excludePatterns | [] | extra directory names excluded from search |
| fileSearch.includeAddedDirs | true | fan the search out across dsh-add-dir added directories |
| sessionScope | workspace | candidate scope: same-cwd only, or every local session |
| sessionReferenceMode | snapshot | snapshot (v1) or lazy `read_session` reference (M5) |
| maxReferenceBytes | 65536 | UTF-8 byte budget per referenced-session snapshot |
| maxReferences | 3 | distinct referenced sessions per message (hard cap 3) |
| readPage.maxBytes / maxTurns | 65536 / 20 | lazy `read_session` page bounds (M5) |

## HTTP surface

- `GET /api/at-mention.search-files?cwd=<…>&q=<…>` → `{ files: [{ abs, rel, root }], truncated }`
- `GET /api/at-mention.resolve-session?id=<…>` → `{ exists }`
- `GET /api/at-mention.stat-file?cwd=<…>&path=<…>` → `{ exists }`

## Model Experience

- **Snapshot mode**: for each referenced session, one additional user message
  (`source.kind: 'session-reference'`, form `recall`) carrying the core
  untrusted `<referenced-sessions>` JSON, bounded per session by
  `maxReferenceBytes`. The user's message text keeps readable `@label` spans.
- **Tokens**: up to `maxReferences × maxReferenceBytes` of referenced context
  is paid eagerly at send time; file references cost only the path text.
- **KV cache**: injected snapshot context is a fresh user message, so it
  shifts subsequent positions within the step it belongs to; it is durable
  and replayable from the session log.
- **Degraded references** (self, duplicate, overflow beyond `maxReferences`,
  failed reads) become a durable `plugin/notice` row naming what was dropped —
  never a silent downgrade.

## Known Limitations and Deferred Work

- Session search matches titles only (no content/branch/project search);
  candidate data comes from the client session list (zero RPC).
- Directory references and Tab descend are unsupported (the trigger pipeline
  arbitrates only ↑/↓/Enter/Esc).
- The trigger menu has no empty-state copy slot, so the file group simply
  hides on an empty query; the session group offers 3 recent entries.
- Menu group titles are hardcoded Chinese source names (`文件` / `会话`):
  the `slash.menu` locale namespace is single-owner, so a third-party plugin
  cannot register localized group titles.
- The client cannot see the draft's chips (the source holds no draft state):
  duplicate chips and the 4th+ session chip are not flagged pre-send; the
  host deduplicates and surfaces an overflow notice row instead.
- The lazy `read_session` mode: the injected notice is a `plugin/notice` row
  (the closed `ContextForm` vocabulary has no reference form), so the
  transcript row labels the plugin rather than the referenced titles; the
  notice text itself carries labels and ids.
- Run `pnpm run build` before `pnpm run test`: the built-bundle smoke
  (`tests/bundle.test.js`) mounts `lib/index.js` and skips itself when the
  artifact is absent.
