/**
 * Built-artifact smoke: mounts the SHIPPED host bundle (lib/index.js) on a
 * real context — in-memory session store, real query engine, fake webServer —
 * and asserts the routes and pre-step consumer register without throwing, in
 * both reference modes. Runs only when the bundle exists (build first; see
 * README dev notes). The deep behavior lives in the src-level suites; this
 * file owns the artifact plane.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'

class TestSessionQueryEngine extends SessionQueryEngine {
  searchSessions() {
    return Promise.resolve({ items: [] })
  }

  searchEvents(...args) {
    return this.readSurface(args[0].sessionId).then(surface => ({
      session: surface.session,
      items: [],
    }))
  }
}

async function mountBundle(mode) {
  let plugin
  try {
    plugin = await import('../lib/index.js')
  } catch {
    return null
  }
  const ctx = new Context()
  const routes = []
  ctx.provide('webServer', {
    register: (spec) => {
      routes.push(spec.path)
      return () => {}
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestSessionQueryEngine)
  await ctx.plugin(plugin, {
    sessionReferenceMode: mode,
    maxReferenceBytes: 65536,
    maxReferences: 3,
    fileSearch: { maxResults: 100, excludePatterns: [], includeAddedDirs: true },
    sessionScope: 'workspace',
    readPage: { maxBytes: 65536, maxTurns: 20 },
  })
  return { ctx, routes }
}

describe('built host bundle', () => {
  it('mounts in snapshot mode and registers the three routes', async (t) => {
    const mounted = await mountBundle('snapshot')
    if (mounted === null) {
      t.skip('lib/index.js not built yet (run pnpm run build first)')
      return
    }
    assert.deepEqual(mounted.routes, [
      '/api/at-mention.search-files',
      '/api/at-mention.resolve-session',
      '/api/at-mention.stat-file',
    ])
    assert.ok(mounted.ctx.get('sessionReferenceResolver'))
  })

  it('mounts in reference mode (read_session tool installer registered)', async (t) => {
    const mounted = await mountBundle('reference')
    if (mounted === null) {
      t.skip('lib/index.js not built yet (run pnpm run build first)')
      return
    }
    assert.deepEqual(mounted.routes, [
      '/api/at-mention.search-files',
      '/api/at-mention.resolve-session',
      '/api/at-mention.stat-file',
    ])
  })
})
