/**
 * Host HTTP surface for the client half: three read-only routes over
 * ctx.webServer. Payloads are query strings only; every input is validated
 * host-side. The search route reuses the core ripgrep seam with a fabricated
 * execution context (the session cwd rides a minimal exec projection, the
 * same discipline as dsh-add-dir's per-directory fan-out).
 * @module dsh-at-mention/src/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  RAW_OUTPUT_MAX_BYTES,
  SEARCH_GRACE_MS,
  SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS,
  runRipgrep,
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
      sendJson(res, 500, { ok: false, error: { code: 'internal', message } })
    }
  }
}

/** Fabricate the minimal exec projection runRipgrep reads (cwd + signal). */
function searchExec(root: string, signal: AbortSignal): ToolExecution {
  return {
    signal,
    agent: { session: { header: { cwd: root } } },
  } as unknown as ToolExecution
}

/** One search run over one root, bounded and cancellation-wired. */
async function searchRoot(
  ctx: Context,
  root: string,
  argv: readonly string[],
  signal: AbortSignal,
): Promise<{ absPaths: string[] }> {
  const run = await runRipgrep(
    ctx,
    searchExec(root, signal),
    'glob',
    [...argv, root],
    RAW_OUTPUT_MAX_BYTES,
    SEARCH_GRACE_MS,
    SEARCH_STDERR_MAX_BYTES,
  )
  if (run.noMatches) return { absPaths: [] }
  const absPaths: string[] = []
  const seen = new Set<string>()
  for (const line of run.stdout.split('\n')) {
    if (line.length === 0) continue
    const abs = toAbsolutePath(line, run.workdir)
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
          if (ctx.get('subprocess') === undefined) {
            sendJson(res, 503, { ok: false, error: { code: 'search-unavailable', message: 'file search requires the subprocess service' } })
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
              const { absPaths } = await searchRoot(ctx, root, argv, controller.signal)
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
