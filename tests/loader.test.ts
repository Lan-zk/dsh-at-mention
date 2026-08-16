import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

/**
 * Loader composition test (04-plugin-workflow §4): boots the SHIPPED bundle
 * (lib/index.js) through the same Cordis Loader the dsh CLI drives, over a
 * real session store and a real query-engine row, with a stub webServer
 * capturing the route surface. Runs only when the bundle exists (build
 * first; see README dev notes).
 */

interface RouteSpec {
  kind: string
  path: string
  handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void
}

async function boot(mode: 'snapshot' | 'reference'): Promise<{
  ctx: Context
  loader: Loader
  routes: RouteSpec[]
  disposed: string[]
  invoke: (path: string, url: string) => Promise<{ status: number; body: unknown }>
} | null> {
  let plugin: { name?: unknown } | undefined
  try {
    // Variable specifier: the built bundle has no adjacent declarations, and
    // a static import would raise TS7016. The runtime assertions below own
    // the shape check (the bundle is a build artifact, not a typed boundary).
    const specifier = '../lib/index.js'
    plugin = await import(specifier) as { name?: unknown }
  } catch {
    return null
  }
  const ctx = new Context()
  const routes: RouteSpec[] = []
  const disposed: string[] = []
  ctx.provide('webServer', {
    register: (spec: RouteSpec) => {
      routes.push(spec)
      return () => { disposed.push(spec.path) }
    },
  })
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(`${process.cwd()}/`).href })
  // The published EntryOptions d.ts omits the runtime-accepted id field (the
  // boot glue passes id the same way); the loader honors it at runtime.
  const row = (id: string, name: string, config?: Record<string, unknown>) =>
    ctx.loader.create({ id, name, ...(config === undefined ? {} : { config }) } as never)
  await row('session-store', '@deepseek-ai/dsh-session')
  await row('session-query', './tests/helpers/test-engine.js')
  await row('at-mention', './lib/index.js', {
    sessionReferenceMode: mode,
    maxReferenceBytes: 65536,
    maxReferences: 3,
    fileSearch: { maxResults: 100, excludePatterns: [], includeAddedDirs: true },
    sessionScope: 'workspace',
    readPage: { maxBytes: 65536, maxTurns: 20 },
  })
  await ctx.loader.await()
  assert.equal(plugin.name, 'at-mention')
  return {
    ctx,
    loader: ctx.loader,
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

describe('loader composition', () => {
  it('boots the shipped bundle in snapshot mode with real session services', async (t) => {
    const mounted = await boot('snapshot')
    if (mounted === null) {
      t.skip('lib/index.js not built yet (run pnpm run build first)')
      return
    }
    assert.deepEqual(mounted.routes.map(route => route.path), [
      '/api/at-mention.search-files',
      '/api/at-mention.resolve-session',
      '/api/at-mention.stat-file',
    ])
    assert.ok(mounted.ctx.get('sessionReferenceResolver'))
    // Route wiring proof: no subprocess → 503; real query engine → empty corpus.
    const search = await mounted.invoke('/api/at-mention.search-files', '/api/at-mention.search-files?cwd=%2Fw&q=conf')
    assert.equal(search.status, 503)
    assert.deepEqual((search.body as { error: { code: string } }).error.code, 'search-unavailable')
    const probe = await mounted.invoke('/api/at-mention.resolve-session', '/api/at-mention.resolve-session?id=abc')
    assert.deepEqual((probe.body as { value: { exists: boolean } }).value, { exists: false })
    // Loader-level disposal: removing the row disposes every route registration.
    await mounted.loader.remove('at-mention')
    await mounted.loader.await()
    assert.deepEqual(mounted.disposed.sort(), [
      '/api/at-mention.resolve-session',
      '/api/at-mention.search-files',
      '/api/at-mention.stat-file',
    ])
  })

  it('boots in reference mode (read_session tool installer registered)', async (t) => {
    const mounted = await boot('reference')
    if (mounted === null) {
      t.skip('lib/index.js not built yet (run pnpm run build first)')
      return
    }
    assert.ok(mounted.ctx.get('sessionReferenceResolver'))
    assert.equal(mounted.routes.length, 3)
  })
})
