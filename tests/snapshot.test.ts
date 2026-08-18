import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionReferenceResolver, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type { SessionReferenceResolver as ResolverType } from '@deepseek-ai/dsh-session-reference'
import { transformSnapshotMessages } from '../src/consumer.ts'
import type { ConsumerOptions } from '../src/consumer.ts'

/**
 * Assembled-transcript snapshots: pins the durable shapes the session log
 * records for injected context and degradation rows. The model-visible text
 * of the snapshot payload itself is core-pinned (its own package tests); the
 * shapes below are this plugin's persistence contract.
 */

class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(
    ..._args: Parameters<SessionQueryEngine['searchSessions']>
  ): ReturnType<SessionQueryEngine['searchSessions']> {
    return Promise.resolve({ items: [] }) as ReturnType<SessionQueryEngine['searchSessions']>
  }

  override searchEvents(
    ...args: Parameters<SessionQueryEngine['searchEvents']>
  ): ReturnType<SessionQueryEngine['searchEvents']> {
    return this.readSurface(args[0].sessionId).then(surface => ({
      session: surface.session,
      items: [],
    })) as ReturnType<SessionQueryEngine['searchEvents']>
  }
}

async function harness(): Promise<{ ctx: Context; resolver: ResolverType }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestSessionQueryEngine)
  await ctx.plugin(SessionReferenceResolver, { maxReferenceBytes: 65536, maxReferences: 3 })
  const resolver = ctx.get('sessionReferenceResolver') as ResolverType
  return { ctx, resolver }
}

const silent = { warn: () => {} }
const signal = new AbortController().signal

function sourceOf(ctx: Context, id: string): void {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd: '/target', createdAt: 20 } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'pinned source line' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('durable transcript shapes', () => {
  it('pins the snapshot context message source and envelope', async () => {
    const { ctx, resolver } = await harness()
    const target = ctx.sessions.create(SessionId('target'), { meta: { cwd: '/target', createdAt: 10 } })
    const agent = { id: target.id, session: target } as Agent
    sourceOf(ctx, 'source')
    const mention = formatSessionReferenceMention({ sessionId: SessionId('source'), label: 'src' })
    const out = await transformSnapshotMessages(agent, [createUserMessage({
      content: [{ type: 'text', text: `use ${mention}` }],
      source: { kind: 'user' },
    })], signal, resolver, silent, { mode: 'snapshot', maxReferences: 3 })
    assert.equal(out.length, 2)
    const context = out[0]
    if (context === undefined) throw new Error('missing context row')
    assert.equal(context.source.kind, 'session-reference')
    assert.equal(context.source.form, 'recall')
    const reference = (context.source as { references: Array<Record<string, unknown>> }).references[0]
    assert.equal(reference?.['sessionId'], 'source')
    assert.equal(reference?.['label'], 'src')
    assert.equal(typeof reference?.['capturedThroughSeq'], 'number')
    const text = context.content[0]
    if (text?.type !== 'text') throw new Error('expected text block')
    assert.ok(text.text.startsWith('## Referenced sessions'))
    assert.ok(text.text.includes('untrusted, read-only snapshot'))
    assert.ok(text.text.includes('<referenced-sessions>'))
    assert.ok(text.text.includes('pinned source line'))
  })

  it('pins the degradation notice row (plugin form notice, bounded summary)', async () => {
    const { ctx, resolver } = await harness()
    const target = ctx.sessions.create(SessionId('target'), { meta: { cwd: '/target', createdAt: 10 } })
    const agent = { id: target.id, session: target } as Agent
    const mention = formatSessionReferenceMention({ sessionId: SessionId('ghost'), label: 'ghost' })
    const out = await transformSnapshotMessages(agent, [createUserMessage({
      content: [{ type: 'text', text: `use ${mention}` }],
      source: { kind: 'user' },
    })], signal, resolver, silent, { mode: 'snapshot', maxReferences: 3 })
    const notice = out[0]
    if (notice === undefined) throw new Error('missing notice row')
    assert.equal(notice.source.kind, 'plugin')
    assert.equal(notice.source.form, 'notice')
    assert.ok((notice.source.summary as string).length <= 120)
    assert.ok((notice.source.summary as string).startsWith('被引用的会话内容无法加载'))
  })

  it('pins the live-reference notice summary in reference mode', async () => {
    const { ctx, resolver } = await harness()
    const target = ctx.sessions.create(SessionId('target'), { meta: { cwd: '/target', createdAt: 10 } })
    const agent = { id: target.id, session: target } as Agent
    sourceOf(ctx, 'source')
    const mention = formatSessionReferenceMention({ sessionId: SessionId('source'), label: '源会话' })
    const out = await transformSnapshotMessages(agent, [createUserMessage({
      content: [{ type: 'text', text: `use ${mention}` }],
      source: { kind: 'user' },
    })], signal, resolver, silent, { mode: 'reference', maxReferences: 3 })
    const notice = out[0]
    if (notice === undefined) throw new Error('missing notice row')
    assert.equal(notice.source.kind, 'plugin')
    assert.equal(notice.source.form, 'notice')
    assert.equal(notice.source.summary, '活引用：源会话')
  })
})
