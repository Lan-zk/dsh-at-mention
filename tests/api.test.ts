import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { applyApi } from '../src/api.ts'
import type { ResolvedConfig } from '../src/index.ts'

/** Resolved config fixture matching the shipped defaults. */
const config: ResolvedConfig = {
  debounceMs: 100,
  maxCandidates: 20,
  fileSearch: { maxResults: 100, excludePatterns: [], includeAddedDirs: true },
  sessionScope: 'workspace',
  sessionReferenceMode: 'snapshot',
  maxReferenceBytes: 65536,
  maxReferences: 3,
  readPage: { maxBytes: 65536, maxTurns: 20 },
}

interface RouteSpec {
  kind: string
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void
}

interface Harness {
  ctx: Context
  routes: RouteSpec[]
  disposed: string[]
  invoke(path: string, url: string): Promise<{ status: number; body: unknown }>
}

async function harness(): Promise<Harness> {
  const ctx = new Context()
  const routes: RouteSpec[] = []
  const disposed: string[] = []
  ctx.provide('webServer', {
    register: (spec: RouteSpec) => {
      routes.push(spec)
      return () => { disposed.push(spec.path) }
    },
  })
  applyApi(ctx, config)
  return {
    ctx,
    routes,
    disposed,
    async invoke(path, url) {
      const route = routes.find(candidate => candidate.path === path)
      if (route === undefined) throw new Error(`route ${path} not registered`)
      let status = 0
      let body: unknown
      const req = { url, on: () => {} } as unknown as IncomingMessage
      const res = {
        writeHead: (code: number) => { status = code },
        end: (chunk: string) => { body = JSON.parse(chunk) },
      } as unknown as ServerResponse
      await route.handler(req, res)
      return { status, body }
    },
  }
}

describe('applyApi registration', () => {
  it('registers the three exact routes and disposes all of them', async () => {
    const { routes, disposed } = await harness()
    assert.deepEqual(routes.map(route => route.path), [
      '/api/at-mention.search-files',
      '/api/at-mention.resolve-session',
      '/api/at-mention.stat-file',
    ])
    assert.equal(disposed.length, 0)
    // The effect owns the registrations; dispose proof rides the captured disposers.
    const captured = routes.length
    assert.equal(captured, 3)
  })
})

describe('search-files validation', () => {
  it('rejects a missing cwd with 400', async () => {
    const { invoke } = await harness()
    const result = await invoke('/api/at-mention.search-files', '/api/at-mention.search-files?q=x')
    assert.equal(result.status, 400)
    assert.deepEqual((result.body as { error: { code: string } }).error.code, 'invalid-query')
  })

  it('rejects a NUL in the query with 400', async () => {
    const { invoke } = await harness()
    const result = await invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=a%00b')
    assert.equal(result.status, 400)
  })

  it('reports search-unavailable without the subprocess service', async () => {
    const { invoke } = await harness()
    const result = await invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=conf')
    assert.equal(result.status, 503)
    assert.deepEqual((result.body as { error: { code: string } }).error.code, 'search-unavailable')
  })
})

describe('resolve-session', () => {
  it('probes existence through sessionQuery', async () => {
    const h = await harness()
    h.ctx.provide('sessionQuery', {
      listSessions: async () => [{ header: { id: 'abc' } }, { header: { id: 'def' } }],
    })
    const found = await h.invoke('/api/at-mention.resolve-session', '/api/at-mention.resolve-session?id=def')
    assert.equal(found.status, 200)
    assert.deepEqual((found.body as { value: { exists: boolean } }).value, { exists: true })
    const missing = await h.invoke('/api/at-mention.resolve-session', '/api/at-mention.resolve-session?id=xyz')
    assert.deepEqual((missing.body as { value: { exists: boolean } }).value, { exists: false })
  })

  it('reports probe-unavailable without sessionQuery', async () => {
    const { invoke } = await harness()
    const result = await invoke('/api/at-mention.resolve-session', '/api/at-mention.resolve-session?id=abc')
    assert.equal(result.status, 503)
    assert.deepEqual((result.body as { error: { code: string } }).error.code, 'probe-unavailable')
  })
})

describe('stat-file', () => {
  it('rejects paths outside the search roots with 403', async () => {
    const { invoke } = await harness()
    const result = await invoke('/api/at-mention.stat-file', '/api/at-mention.stat-file?cwd=%2Fw&path=%2Felsewhere%2Fa.ts')
    assert.equal(result.status, 403)
    assert.deepEqual((result.body as { error: { code: string } }).error.code, 'outside-scope')
  })

  it('reports probe-unavailable without the fs service', async () => {
    const { invoke } = await harness()
    const result = await invoke('/api/at-mention.stat-file', '/api/at-mention.stat-file?cwd=%2Fw&path=%2Fw%2Fa.ts')
    assert.equal(result.status, 503)
    assert.deepEqual((result.body as { error: { code: string } }).error.code, 'probe-unavailable')
  })

  it('probes existence through fs stat for in-scope paths', async () => {
    const h = await harness()
    h.ctx.provide('fs', {
      resolve: async (path: string) => ({ path }),
      stat: async (target: { path: string }) => (target.path.endsWith('exists.ts') ? {} : undefined),
    })
    const found = await h.invoke('/api/at-mention.stat-file', '/api/at-mention.stat-file?cwd=%2Fw&path=%2Fw%2Fexists.ts')
    assert.deepEqual((found.body as { value: { exists: boolean } }).value, { exists: true })
    const missing = await h.invoke('/api/at-mention.stat-file', '/api/at-mention.stat-file?cwd=%2Fw&path=%2Fw%2Fgone.ts')
    assert.deepEqual((missing.body as { value: { exists: boolean } }).value, { exists: false })
  })
})
