/**
 * Host HTTP surface for the client half: three read-only routes over
 * ctx.webServer. Payloads are query strings only; every input is validated
 * host-side. The search route spawns the packaged ripgrep binary directly
 * through the subprocess seam with its own per-call binary resolution — not
 * the core tool-fs-search runner, whose memoized resolver can stick in a
 * broken state for the whole process and hides the launch failure cause.
 * @module dsh-at-mention/src/api
 */

import { createRequire } from 'node:module'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
} from '@deepseek-ai/dsh-tool-fs-search'
import type { ResolvedConfig } from './index.ts'
import {
  buildSearchArgv,
  resolveRoots,
  toAbsolutePath,
  toFileView,
} from './search.ts'
import type { FileView } from './search.ts'

/** Wire-input limits: short strings only, NUL-free. */
const MAX_CWD_BYTES = 4096
const MAX_QUERY_BYTES = 1024
const MAX_SESSION_ID_BYTES = 1024

/** The require hook anchored at this module, for per-call ripgrep resolution. */
const require = createRequire(import.meta.url)

/**
 * Resolve the packaged ripgrep binary FRESH on every call. The core
 * tool-fs-search seam memoizes this resolution per process, so one transient
 * failure (an install in flight, a briefly missing platform package) sticks
 * for the lifetime of the harness process and every later search fails
 * opaquely. A filesystem-backed `require.resolve` cannot stick: it mirrors
 * `@vscode/ripgrep`'s own lookup (ask for the platform package's binary
 * through the main package's module directory, where the optional platform
 * sibling resolves in every hoisting layout) and reports the real reason on
 * failure.
 * @returns the absolute binary path.
 */
function resolveRipgrepPath(): string {
  const binaryName = process.platform === 'win32' ? 'rg.exe' : 'rg'
  const platformPkg = `@vscode/ripgrep-${process.platform}-${process.arch}`
  const mainEntry = require.resolve('@vscode/ripgrep')
  return createRequire(mainEntry).resolve(`${platformPkg}/bin/${binaryName}`)
}

/** Join an error's cause chain into one bounded diagnostic line. */
function chainMessage(error: unknown, maxDepth = 3): string {
  const parts: string[] = []
  let current: unknown = error
  while (current instanceof Error && parts.length < maxDepth) {
    parts.push(current.message)
    current = current.cause
  }
  const text = parts.join(' → ')
  return text.length <= 300 ? text : `${text.slice(0, 297)}...`
}

/** The subprocess seam face the search route reads (minimal structural contract). */
interface SubprocessLike {
  spawn(spec: {
    argv: string[]
    cwd: string
    stdio: {
      stdin: 'ignore'
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs: number
    signal: AbortSignal
  }): {
    done: Promise<{ exitCode: number | null; signal: string | null }>
    collected: {
      stdout?: { readFrom(fromByte: number): { text: string; lossy: boolean } }
      stderr?: { readFrom(fromByte: number): { text: string; lossy: boolean } }
    }
  }
}

/** Closed validation failure code. */
class RouteError extends Error {
  readonly code: 'invalid-query' | 'outside-scope'

  constructor(code: 'invalid-query' | 'outside-scope', message: string) {
    super(message)
    this.name = 'RouteError'
    this.code = code
  }
}

/** Minimal session-query face used by the resolve-session probe. */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: unknown } }>>
}

/** Minimal fs face used by the stat-file probe. */
interface FileSystemLike {
  resolve(path: string): Promise<{}>
  stat(target: {}, signal?: AbortSignal): Promise<unknown>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Read one query parameter as a validated string. */
function queryField(url: URL, name: string, maxBytes: number): string {
  const value = url.searchParams.get(name)
  if (value === null || value.trim().length === 0 || Buffer.byteLength(value) > maxBytes || value.includes('\0')) {
    throw new RouteError('invalid-query', `${name} must be a non-empty string of at most ${maxBytes} bytes without NUL`)
  }
  return value.trim()
}

/** Remove absolute-path-like substrings from client-visible error text. */
function sanitizeError(message: string): string {
  return message.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s:]*/g, '<path>')
}

/** Wrap one route handler with the closed error mapping. */
function handle(ctx: Context, run: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      await run(req, res)
    } catch (error) {
      if (error instanceof RouteError) {
        sendJson(res, error.code === 'outside-scope' ? 403 : 400, {
          ok: false,
          error: { code: error.code, message: error.message },
        })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn('at-mention api failure: %s', message)
      sendJson(res, 500, { ok: false, error: { code: 'internal', message: sanitizeError(message) } })
    }
  }
}

/**
 * One search run over one root, bounded and cancellation-wired. Spawns the
 * packaged ripgrep directly through the subprocess seam with the plugin's own
 * per-call binary resolution (see {@link resolveRipgrepPath}): the core
 * tool-fs-search runner is not reused because its memoized resolver hides the
 * launch failure cause and can stick in a broken state for the whole process.
 * Exit semantics mirror the core: 0 = results, 1 = no matches, anything else
 * fails with the real diagnostic in the message.
 * @param subprocess - the subprocess service.
 * @param rgPath - resolved packaged ripgrep binary.
 * @param root - absolute search root (also the spawn workdir).
 * @param argv - ripgrep argv without the trailing root path.
 * @param signal - route-level abort signal.
 */
async function searchRoot(
  subprocess: SubprocessLike,
  rgPath: string,
  root: string,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ absPaths: string[] }> {
  if (signal.aborted) return { absPaths: [] }
  let handle: ReturnType<SubprocessLike['spawn']>
  try {
    handle = subprocess.spawn({
      argv: [rgPath, '--no-config', ...argv, root],
      cwd: root,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: RAW_OUTPUT_MAX_BYTES },
        stderr: { maxBytes: SEARCH_STDERR_MAX_BYTES },
      },
      graceMs: SEARCH_GRACE_MS,
      signal,
    })
  } catch (error: unknown) {
    if (signal.aborted) return { absPaths: [] }
    throw new Error(`ripgrep failed to start: ${chainMessage(error)}`)
  }
  let outcome: Awaited<ReturnType<SubprocessLike['spawn']>['done']>
  try {
    outcome = await handle.done
  } catch (error: unknown) {
    if (signal.aborted) return { absPaths: [] }
    throw new Error(`ripgrep failed to start: ${chainMessage(error)}`)
  }
  if (signal.aborted) return { absPaths: [] }
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined) throw new Error('ripgrep produced no collected output streams')
  if (outcome.signal !== null || outcome.exitCode === null) throw new Error(`ripgrep was killed by signal ${outcome.signal ?? '(unknown)'}`)
  if (outcome.exitCode === 1) return { absPaths: [] }
  if (outcome.exitCode !== 0) {
    const stderrText = stderr.text.trim()
    throw new Error(`ripgrep search failed (exit ${outcome.exitCode})${stderrText.length > 0 ? `: ${stderrText.slice(0, 200)}` : ''}`)
  }
  if (stdout.lossy || Buffer.byteLength(stdout.text, 'utf8') > RAW_OUTPUT_MAX_BYTES) {
    throw new Error('ripgrep output exceeded the capture cap; narrow the query')
  }
  const absPaths: string[] = []
  const seen = new Set<string>()
  for (const line of stdout.text.split('\n')) {
    if (line.length === 0) continue
    const abs = toAbsolutePath(line, root)
    if (!seen.has(abs)) {
      seen.add(abs)
      absPaths.push(abs)
    }
  }
  return { absPaths }
}

/**
 * Register the at-mention routes. Every registration returns its disposer
 * and rides one effect, so dispose leaves nothing behind.
 * @param ctx - the plugin context.
 * @param config - resolved plugin config.
 */
export function applyApi(ctx: Context, config: ResolvedConfig): void {
  ctx.effect(() => {
    const routes = [
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/at-mention.search-files',
        handler: handle(ctx, async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const cwd = queryField(url, 'cwd', MAX_CWD_BYTES)
          const query = queryField(url, 'q', MAX_QUERY_BYTES)
          const subprocess = ctx.get('subprocess') as SubprocessLike | undefined
          if (subprocess === undefined) {
            sendJson(res, 503, { ok: false, error: { code: 'search-unavailable', message: 'file search requires the subprocess service' } })
            return
          }
          let rgPath: string
          try {
            rgPath = resolveRipgrepPath()
          } catch (error: unknown) {
            sendJson(res, 503, { ok: false, error: { code: 'search-unavailable', message: `packaged ripgrep unavailable: ${chainMessage(error)}` } })
            return
          }
          const controller = new AbortController()
          const timer = setTimeout(() => { controller.abort() }, SEARCH_TIMEOUT_MS)
          req.on('close', () => { controller.abort() })
          try {
            const roots = resolveRoots(ctx, cwd, config.fileSearch.includeAddedDirs)
            const argv = buildSearchArgv(query, config.fileSearch.excludePatterns)
            const files: FileView[] = []
            const seen = new Set<string>()
            let truncated = false
            for (const root of roots) {
              const { absPaths } = await searchRoot(subprocess, rgPath, root, argv, controller.signal)
              for (const abs of absPaths) {
                if (seen.has(abs)) continue
                seen.add(abs)
                if (files.length >= config.fileSearch.maxResults) {
                  truncated = true
                  break
                }
                files.push(toFileView(roots, abs))
              }
              if (truncated) break
            }
            sendJson(res, 200, { ok: true, value: { files, truncated } })
          } finally {
            clearTimeout(timer)
          }
        }),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/at-mention.resolve-session',
        handler: handle(ctx, async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const id = queryField(url, 'id', MAX_SESSION_ID_BYTES)
          const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
          if (sessionQuery === undefined) {
            sendJson(res, 503, { ok: false, error: { code: 'probe-unavailable', message: 'session probing requires the sessionQuery service' } })
            return
          }
          const records = await sessionQuery.listSessions()
          const exists = records.some(record => String(record.header.id) === id)
          sendJson(res, 200, { ok: true, value: { exists } })
        }),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/at-mention.stat-file',
        handler: handle(ctx, async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const cwd = queryField(url, 'cwd', MAX_CWD_BYTES)
          const path = queryField(url, 'path', MAX_CWD_BYTES)
          const roots = resolveRoots(ctx, cwd, config.fileSearch.includeAddedDirs)
          const inScope = roots.some(root => toFileView([root], path).root !== '其他')
          if (!inScope) {
            throw new RouteError('outside-scope', 'path must lie inside the workspace search roots')
          }
          const fs = ctx.get('fs') as FileSystemLike | undefined
          if (fs === undefined) {
            sendJson(res, 503, { ok: false, error: { code: 'probe-unavailable', message: 'file probing requires the fs service' } })
            return
          }
          const target = await fs.resolve(path)
          const info = await fs.stat(target)
          sendJson(res, 200, { ok: true, value: { exists: info !== undefined } })
        }),
      }),
    ]
    return () => {
      for (const dispose of routes) dispose()
    }
  }, 'at-mention.apiRoutes')
}
