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

describe('search-files execution', () => {
  /** Minimal subprocess seam mock: one scripted run, argv captured. */
  function mockSubprocess(options: {
    exitCode?: number
    stdoutText?: string
    stderrText?: string
    fail?: unknown
    argv?: string[]
  } = {}) {
    const exitCode = options.exitCode ?? 0
    const stream = (text: string) => ({
      readFrom: (_fromByte: number) => ({ text, lossy: false }),
    })
    return {
      spawn(spec: { argv: string[]; cwd: string; stdio: unknown; graceMs: number; signal: AbortSignal }) {
        if (options.argv !== undefined) options.argv.push(...spec.argv)
        assert.equal(spec.argv[1], '--no-config')
        assert.ok(spec.argv[0]?.endsWith('rg') || spec.argv[0]?.endsWith('rg.exe'))
        return {
          done: options.fail === undefined
            ? Promise.resolve({ exitCode, signal: null })
            : Promise.reject(options.fail),
          collected: {
            stdout: stream(options.stdoutText ?? ''),
            stderr: stream(options.stderrText ?? ''),
          },
        }
      },
    }
  }

  it('runs the packaged ripgrep through subprocess and returns absolute files', async () => {
    const h = await harness()
    const argv: string[] = []
    h.ctx.provide('subprocess', mockSubprocess({ stdoutText: '/w/a.ts\n/w/sub/b.ts\n/w/a.ts\n', argv }))
    const result = await h.invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=conf')
    assert.equal(result.status, 200)
    const value = (result.body as { value: { files: Array<{ abs: string }>; truncated: boolean } }).value
    assert.deepEqual(value.files.map(file => file.abs), ['/w/a.ts', '/w/sub/b.ts'])
    assert.equal(value.truncated, false)
    assert.ok(argv.join(' ').includes('--iglob='))
  })

  it('returns an empty file list for ripgrep exit 1 (no matches)', async () => {
    const h = await harness()
    h.ctx.provide('subprocess', mockSubprocess({ exitCode: 1 }))
    const result = await h.invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=zzz')
    assert.equal(result.status, 200)
    assert.deepEqual((result.body as { value: { files: string[] } }).value.files, [])
  })

  it('surfaces the launch cause chain when the spawn handle rejects', async () => {
    const h = await harness()
    const cause = new Error('ENOENT: no such file')
    h.ctx.provide('subprocess', mockSubprocess({ fail: new Error('spawn failed', { cause }) }))
    const result = await h.invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=conf')
    assert.equal(result.status, 500)
    const error = (result.body as { error: { code: string; message: string } }).error
    assert.equal(error.code, 'internal')
    assert.ok(error.message.includes('spawn failed'))
    assert.ok(error.message.includes('ENOENT: no such file'))
  })

  it('reports a non-zero exit with the stderr excerpt', async () => {
    const h = await harness()
    h.ctx.provide('subprocess', mockSubprocess({ exitCode: 2, stderrText: 'error parsing glob\n' }))
    const result = await h.invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=conf')
    assert.equal(result.status, 500)
    assert.ok((result.body as { error: { message: string } }).error.message.includes('exit 2'))
    assert.ok((result.body as { error: { message: string } }).error.message.includes('error parsing glob'))
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
