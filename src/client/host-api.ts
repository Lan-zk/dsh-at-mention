/**
 * Host HTTP surface client: three read-only probes over page-context fetch.
 * Every call forwards the caller's AbortSignal; non-ok envelopes throw a
 * typed ApiError so the trigger sources can map failures to user-visible
 * menu states.
 * @module dsh-at-mention/src/client/host-api
 */

/** One search result row (host wire form). */
export interface SearchFileRow {
  abs: string
  rel: string
  root: string
}

/** Closed API failure. */
export class ApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ApiError'
  }
}

async function call<T>(path: string, params: URLSearchParams, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${path}?${params.toString()}`, { signal })
  const body = await response.json() as { ok: boolean; value?: T; error?: { code: string; message: string } }
  if (!body.ok || body.value === undefined) {
    const error = body.error
    throw new ApiError(error?.code ?? 'internal', error?.message ?? 'request failed')
  }
  return body.value
}

/**
 * Search workspace files.
 * @param cwd - session working directory.
 * @param query - search query.
 * @param signal - supersede/abort signal.
 */
export async function searchFiles(cwd: string, query: string, signal: AbortSignal): Promise<{ files: SearchFileRow[]; truncated: boolean }> {
  return await call('/api/at-mention.search-files', new URLSearchParams({ cwd, q: query }), signal)
}

/**
 * Probe one session's existence.
 * @param id - session id.
 * @param signal - supersede/abort signal.
 */
export async function resolveSession(id: string, signal: AbortSignal): Promise<boolean> {
  const value = await call<{ exists: boolean }>('/api/at-mention.resolve-session', new URLSearchParams({ id }), signal)
  return value.exists
}

/**
 * Probe one file's existence inside the workspace search roots.
 * @param cwd - session working directory.
 * @param path - absolute file path.
 * @param signal - supersede/abort signal.
 */
export async function statFile(cwd: string, path: string, signal: AbortSignal): Promise<boolean> {
  const value = await call<{ exists: boolean }>('/api/at-mention.stat-file', new URLSearchParams({ cwd, path }), signal)
  return value.exists
}

/** Debounce that settles immediately on an already-aborted signal and cleans
 * up both the timer and the abort listener when either path wins. */
export async function debounce(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', settle)
      resolve()
    }
    const timer = setTimeout(settle, ms)
    signal.addEventListener('abort', settle, { once: true })
  })
}
