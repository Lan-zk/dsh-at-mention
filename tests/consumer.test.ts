import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionReferenceResolver, { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference'
import type { SessionReferenceResolver as ResolverType } from '@deepseek-ai/dsh-session-reference'
import { transformSnapshotMessages } from '../src/consumer.ts'
import type { ConsumerOptions } from '../src/consumer.ts'
import { encodeSessionReference } from '../src/shared/reference-format.ts'

/** Quiet logger for degrade paths. */
const silent = { warn: () => {} }

/** The rc.6 engine leaves full-text search abstract; the snapshot path only needs the concrete reads. */
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

/** Real composition: in-memory store + query engine + the reference resolver. */
async function harness(): Promise<{ ctx: Context; resolver: ResolverType }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestSessionQueryEngine)
  await ctx.plugin(SessionReferenceResolver, { maxReferenceBytes: 65536, maxReferences: 3 })
  const resolver = ctx.get('sessionReferenceResolver') as ResolverType
  return { ctx, resolver }
}

function fakeAgent(ctx: Context, id: string, cwd = '/target'): Agent {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd, createdAt: 10 } })
  return { id: session.id, session } as Agent
}

function sourceSession(ctx: Context, id: string, cwd = '/target'): { id: string } {
  const session = ctx.sessions.create(SessionId(id), { meta: { cwd, createdAt: 20 } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'source user line' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'source assistant line' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  return { id }
}

const options: ConsumerOptions = { mode: 'snapshot', maxReferences: 3 }
const signal = new AbortController().signal

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('transformSnapshotMessages', () => {
  it('replaces a mention with a readable label and injects the snapshot context before the message', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const source = sourceSession(ctx, 'source')
    const mention = formatSessionReferenceMention({ sessionId: SessionId(source.id), label: '源会话' })
    const out = await transformSnapshotMessages(agent, [userMessage(`compare ${mention} now`)], signal, resolver, silent, options)
    assert.equal(out.length, 2)
    const context = out[0]
    const readable = out[1]
    if (context?.content[0]?.type !== 'text') throw new Error('expected text context')
    assert.equal(context.source.kind, 'session-reference')
    assert.ok(context.content[0].text.includes('untrusted, read-only snapshot'))
    assert.ok(context.content[0].text.includes('source user line'))
    if (readable?.content[0]?.type !== 'text') throw new Error('expected text message')
    assert.equal(readable.content[0].text, 'compare @源会话 now')
    assert.equal(readable.source.kind, 'user')
  })

  it('decodes an encoded plain-text session reference and injects the snapshot context', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const source = sourceSession(ctx, 'source')
    const encoded = encodeSessionReference('源会话', source.id)
    const out = await transformSnapshotMessages(agent, [userMessage(`compare ${encoded} now`)], signal, resolver, silent, options)
    assert.equal(out.length, 2)
    const context = out[0]
    const readable = out[1]
    if (context?.content[0]?.type !== 'text') throw new Error('expected text context')
    assert.equal(context.source.kind, 'session-reference')
    assert.ok(context.content[0].text.includes('source user line'))
    if (readable?.content[0]?.type !== 'text') throw new Error('expected text message')
    assert.equal(readable.content[0].text, 'compare @源会话 now')
    assert.equal(readable.source.kind, 'user')
  })

  it('filters a self reference and surfaces a notice row', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const mention = formatSessionReferenceMention({ sessionId: SessionId('target'), label: 'target' })
    const out = await transformSnapshotMessages(agent, [userMessage(`see ${mention}`)], signal, resolver, silent, options)
    assert.equal(out.length, 2)
    const notice = out[0]
    if (notice?.content[0]?.type !== 'text') throw new Error('expected text notice')
    assert.equal(notice.source.kind, 'plugin')
    assert.ok(notice.content[0].text.includes('target'))
    const readable = out[1]
    if (readable?.content[0]?.type !== 'text') throw new Error('expected text message')
    assert.equal(readable.content[0].text, 'see @target')
  })

  it('keeps the first maxReferences references and names the overflow in a notice', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const a = sourceSession(ctx, 'a')
    const b = sourceSession(ctx, 'b')
    const c = sourceSession(ctx, 'c')
    const d = sourceSession(ctx, 'd')
    const mentionOf = (id: string, label: string) => formatSessionReferenceMention({ sessionId: SessionId(id), label })
    const text = `refs ${mentionOf(a.id, 'a')} ${mentionOf(b.id, 'b')} ${mentionOf(c.id, 'c')} ${mentionOf(d.id, 'd')}`
    const out = await transformSnapshotMessages(agent, [userMessage(text)], signal, resolver, silent, options)
    assert.equal(out.length, 3)
    const context = out[0]
    assert.equal(context?.source.kind, 'session-reference')
    const notice = out[1]
    if (notice?.content[0]?.type !== 'text') throw new Error('expected text notice')
    assert.ok(notice.content[0].text.includes('d'))
    assert.ok(notice.content[0].text.includes('beyond the limit'))
    const readable = out[2]
    if (readable?.content[0]?.type !== 'text') throw new Error('expected text message')
    assert.equal(readable.content[0].text, 'refs @a @b @c @d')
  })

  it('deduplicates a repeated reference silently', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const source = sourceSession(ctx, 'source')
    const mention = formatSessionReferenceMention({ sessionId: SessionId(source.id), label: 'src' })
    const out = await transformSnapshotMessages(agent, [userMessage(`${mention} again ${mention}`)], signal, resolver, silent, options)
    assert.equal(out.length, 2)
    const context = out[0]
    if (context?.content[0]?.type !== 'text') throw new Error('expected text context')
    assert.equal(context.source.kind, 'session-reference')
    const references = context.source.references as Array<{ sessionId: string }>
    assert.equal(references.length, 1)
  })

  it('degrades to labels with a notice when the referenced session cannot be read', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const mention = formatSessionReferenceMention({ sessionId: SessionId('ghost'), label: 'ghost' })
    const out = await transformSnapshotMessages(agent, [userMessage(`use ${mention}`)], signal, resolver, silent, options)
    assert.equal(out.length, 2)
    const notice = out[0]
    if (notice?.content[0]?.type !== 'text') throw new Error('expected text notice')
    assert.equal(notice.source.kind, 'plugin')
    assert.ok(notice.content[0].text.includes('could not be loaded'))
    const readable = out[1]
    if (readable?.content[0]?.type !== 'text') throw new Error('expected text message')
    assert.equal(readable.content[0].text, 'use @ghost')
  })

  it('passes non-user messages through untouched', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const plugin = createUserMessage({
      content: [{ type: 'text', text: 'goal round' }],
      source: { kind: 'plugin', plugin: 'goal' },
    })
    const out = await transformSnapshotMessages(agent, [plugin], signal, resolver, silent, options)
    assert.equal(out.length, 1)
    assert.equal(out[0], plugin)
  })

  it('leaves user messages without mentions untouched (identity preserved)', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const plain = userMessage('no references here')
    const out = await transformSnapshotMessages(agent, [plain], signal, resolver, silent, options)
    assert.equal(out.length, 1)
    assert.equal(out[0], plain)
  })
})

describe('reference mode (lazy arm)', () => {
  const lazy: ConsumerOptions = { mode: 'reference', maxReferences: 3 }

  it('replaces the mention with a readable label and injects a live-reference notice, no snapshot', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const source = sourceSession(ctx, 'source')
    const mention = formatSessionReferenceMention({ sessionId: SessionId(source.id), label: 'src' })
    const out = await transformSnapshotMessages(agent, [userMessage(`use ${mention}`)], signal, resolver, silent, lazy)
    assert.equal(out.length, 2)
    const notice = out[0]
    if (notice?.content[0]?.type !== 'text') throw new Error('expected text notice')
    assert.equal(notice.source.kind, 'plugin')
    assert.equal(notice.source.form, 'notice')
    assert.ok(notice.content[0].text.includes('Live references to 1 other session(s)'))
    assert.ok(notice.content[0].text.includes('src (source)'))
    assert.ok(notice.content[0].text.includes('read_session'))
    const readable = out[1]
    if (readable?.content[0]?.type !== 'text') throw new Error('expected text message')
    assert.equal(readable.content[0].text, 'use @src')
  })

  it('caps at maxReferences and names the overflow', async () => {
    const { ctx, resolver } = await harness()
    const agent = fakeAgent(ctx, 'target')
    const mentions = ['a', 'b', 'c', 'd'].map((id) => {
      sourceSession(ctx, id)
      return formatSessionReferenceMention({ sessionId: SessionId(id), label: id })
    })
    const out = await transformSnapshotMessages(agent, [userMessage(`refs ${mentions.join(' ')}`)], signal, resolver, silent, lazy)
    assert.equal(out.length, 3)
    const live = out[0]
    if (live?.content[0]?.type !== 'text') throw new Error('expected text notice')
    assert.ok(live.content[0].text.includes('a (a)'))
    assert.ok(!live.content[0].text.includes('(d)'))
    const overflow = out[1]
    if (overflow?.content[0]?.type !== 'text') throw new Error('expected text notice')
    assert.ok(overflow.content[0].text.includes('beyond the limit'))
    assert.ok(overflow.content[0].text.includes('d'))
  })
})
