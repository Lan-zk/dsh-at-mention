import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext,
  InputTriggerServiceContract,
  InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { apply } from '../src/client/index.ts'

interface SessionRowLike {
  id: string
  displayTitle: string
  cwd?: string
  parentId?: string
  running: boolean
  blank: boolean
  updatedAt: number
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function makeCtx(rows: readonly SessionRowLike[]): {
  ctx: ClientContext
  sources: InputTriggerSource[]
  disposers: Array<() => void>
} {
  const sources: InputTriggerSource[] = []
  const disposers: Array<() => void> = []
  const inputTriggers: InputTriggerServiceContract = {
    registerSource(source: InputTriggerSource) {
      sources.push(source)
      return () => {
        const index = sources.indexOf(source)
        if (index >= 0) sources.splice(index, 1)
      }
    },
  }
  const ctx = {
    get(name: string) {
      return name === 'inputTriggers' ? inputTriggers : undefined
    },
    effect(fn: () => () => void) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: Object.fromEntries(rows.map(row => [row.id, row])),
        }),
        subscribe: () => () => {},
      },
    },
  } as unknown as ClientContext
  return { ctx, sources, disposers }
}

function sourceBy(sources: readonly InputTriggerSource[], name: string): InputTriggerSource {
  const source = sources.find(item => item.trigger === '@' && item.name === name)
  if (source === undefined) throw new Error(`missing @ source: ${name}`)
  return source
}

const sessionProjection: ClientSessionContext = { sessionId: 'current' }

describe('client @ sources', () => {
  it('registers the 会话 and 文件 sources through apply', async () => {
    const rows: SessionRowLike[] = [
      { id: 'current', displayTitle: 'current', cwd: '/w', running: false, blank: false, updatedAt: 0 },
      { id: 's1', displayTitle: 'Alpha', cwd: '/w', running: false, blank: false, updatedAt: 1 },
    ]
    const { ctx, sources } = makeCtx(rows)
    apply(ctx, { debounceMs: 0, maxCandidates: 20, sessionScope: 'workspace' })
    assert.equal(sources.length, 2)
    assert.deepEqual(sources.map(source => source.name).sort(), ['会话', '文件'])
    assert.ok(sources.every(source => source.trigger === '@'))

    const sessionSource = sourceBy(sources, '会话')
    const candidates = await sessionSource.candidates!(sessionProjection, {
      query: '',
      position: 'leading',
      signal: new AbortController().signal,
    })
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0]?.name, 'Alpha')
    assert.equal('icon' in (candidates[0] ?? {}), false)
  })

  it('keeps a stale file candidate pickable while a newer search is in flight', async () => {
    const rows: SessionRowLike[] = [
      { id: 'current', displayTitle: 'current', cwd: '/w', running: false, blank: false, updatedAt: 0 },
    ]
    const { ctx, sources } = makeCtx(rows)
    apply(ctx, { debounceMs: 0, maxCandidates: 20, sessionScope: 'workspace' })
    const fileSource = sourceBy(sources, '文件')

    type SearchResponse = {
      json(): Promise<{
        ok: boolean
        value?: { files: Array<{ abs: string; rel: string; root: string }>; truncated: boolean }
        error?: { code: string; message: string }
      }>
    }
    const oldFetch = deferred<SearchResponse>()
    const newFetch = deferred<SearchResponse>()

    const originalFetch = globalThis.fetch
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('q=old')) return oldFetch.promise as Promise<Response>
      if (url.includes('q=new')) return newFetch.promise as Promise<Response>
      return Promise.reject(new Error(`unexpected fetch: ${url}`))
    }) as typeof fetch

    try {
      const signal = new AbortController().signal
      const firstPromise = fileSource.candidates!(sessionProjection, {
        query: 'old',
        position: 'leading',
        signal,
      })
      oldFetch.resolve({
        json: async () => ({
          ok: true,
          value: {
            files: [{ abs: '/w/old.ts', rel: 'old.ts', root: '主' }],
            truncated: false,
          },
        }),
      })
      const first = await firstPromise
      assert.equal(first.length, 1)
      assert.equal(first[0]?.name, 'old.ts')
      assert.equal('icon' in (first[0] ?? {}), false)

      const secondPromise = fileSource.candidates!(sessionProjection, {
        query: 'new',
        position: 'leading',
        signal: new AbortController().signal,
      })

      const stalePick = fileSource.onPick!({
        candidate: { name: 'old.ts' },
        session: sessionProjection,
        position: 'leading',
        via: 'menu',
        span: { start: 0, end: 4, draftRev: 1 },
      })
      assert.equal(stalePick !== undefined && 'insert' in stalePick, true)
      if (stalePick !== undefined && 'insert' in stalePick) {
        assert.equal(stalePick.insert.label, 'old.ts')
        assert.equal(stalePick.insert.clipboardText, 'old.ts')
      }

      newFetch.resolve({
        json: async () => ({
          ok: true,
          value: {
            files: [{ abs: '/w/new.ts', rel: 'new.ts', root: '主' }],
            truncated: false,
          },
        }),
      })

      const second = await secondPromise
      assert.equal(second.length, 1)
      assert.equal(second[0]?.name, 'new.ts')

      const oldAfterRefresh = fileSource.onPick!({
        candidate: { name: 'old.ts' },
        session: sessionProjection,
        position: 'leading',
        via: 'menu',
        span: { start: 0, end: 4, draftRev: 2 },
      })
      assert.equal(oldAfterRefresh, undefined)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
