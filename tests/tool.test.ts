import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import { readSessionTool } from '../src/tool.ts'
import type { ReadSessionToolOptions } from '../src/tool.ts'

/** The rc.7 engine leaves full-text search abstract; the tool only needs the concrete reads. */
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

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TestSessionQueryEngine)
  return ctx
}

function makeSession(ctx: Context, id: string, cwd: string): { id: string } {
  return ctx.sessions.create(SessionId(id), { meta: { cwd, createdAt: 10 } })
}

function appendTurn(ctx: Context, id: string, userText: string, assistantText: string): void {
  const session = ctx.sessions.get(SessionId(id))
  if (session === undefined) throw new Error(`session ${id} missing`)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: userText }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: assistantText }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
}

function fakeAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.get(SessionId(id))
  if (session === undefined) throw new Error(`session ${id} missing`)
  return { id: session.id, session } as Agent
}

function execFor(ctx: Context, agentId: string): ToolRunContext {
  return { agent: fakeAgent(ctx, agentId), signal: new AbortController().signal } as ToolRunContext
}

const options: ReadSessionToolOptions = { maxBytes: 65536, maxTurns: 20, scope: 'workspace' }

describe('read_session tool', () => {
  it('reads the referenced session surface in model-history order', async () => {
    const ctx = await harness()
    makeSession(ctx, 'target', '/w')
    makeSession(ctx, 'source', '/w')
    appendTurn(ctx, 'source', 'first user line', 'first assistant line')
    appendTurn(ctx, 'source', 'second user line', 'second assistant line')
    const tool = readSessionTool(ctx, fakeAgent(ctx, 'target'), options)
    const value = await tool.execute({ session_id: 'source' }, execFor(ctx, 'target')) as {
      ok: boolean
      page?: { turns: Array<{ role: string; blocks: Array<{ text: string }> }>; truncated: boolean; next_cursor: string | null }
    }
    assert.equal(value.ok, true)
    assert.equal(value.page?.truncated, false)
    assert.equal(value.page?.next_cursor, undefined)
    assert.deepEqual(
      value.page?.turns.map(turn => [turn.role, turn.blocks[0]?.text]),
      [
        ['user', 'first user line'],
        ['assistant', 'first assistant line'],
        ['user', 'second user line'],
        ['assistant', 'second assistant line'],
      ],
    )
  })

  it('pages by turn cap and resumes through the cursor', async () => {
    const ctx = await harness()
    makeSession(ctx, 'target', '/w')
    makeSession(ctx, 'source', '/w')
    appendTurn(ctx, 'source', 'u1', 'a1')
    appendTurn(ctx, 'source', 'u2', 'a2')
    const paged: ReadSessionToolOptions = { maxBytes: 65536, maxTurns: 2, scope: 'workspace' }
    const tool = readSessionTool(ctx, fakeAgent(ctx, 'target'), paged)
    const first = await tool.execute({ session_id: 'source' }, execFor(ctx, 'target')) as {
      ok: boolean
      page?: { turns: Array<{ role: string }>; truncated: boolean; next_cursor: string | null }
    }
    assert.equal(first.ok, true)
    assert.equal(first.page?.truncated, true)
    assert.equal(first.page?.turns.length, 2)
    const cursor = first.page?.next_cursor
    assert.notEqual(cursor, null)
    const second = await tool.execute({ session_id: 'source', cursor: cursor ?? undefined }, execFor(ctx, 'target')) as {
      ok: boolean
      page?: { turns: Array<{ role: string }>; truncated: boolean; next_cursor: string | null }
    }
    assert.equal(second.ok, true)
    assert.equal(second.page?.truncated, false)
    assert.deepEqual(second.page?.turns.map(turn => turn.role), ['user', 'assistant'])
    assert.equal(second.page?.next_cursor, undefined)
  })

  it('pages by byte budget without splitting a turn', async () => {
    const ctx = await harness()
    makeSession(ctx, 'target', '/w')
    makeSession(ctx, 'source', '/w')
    appendTurn(ctx, 'source', 'short', 'x'.repeat(4000))
    const paged: ReadSessionToolOptions = { maxBytes: 1024, maxTurns: 20, scope: 'workspace' }
    const tool = readSessionTool(ctx, fakeAgent(ctx, 'target'), paged)
    const value = await tool.execute({ session_id: 'source' }, execFor(ctx, 'target')) as {
      ok: boolean
      page?: { turns: Array<{ role: string }>; truncated: boolean; next_cursor: string | null }
    }
    assert.equal(value.ok, true)
    assert.deepEqual(value.page?.turns.map(turn => turn.role), ['user'])
    assert.equal(value.page?.truncated, true)
    assert.notEqual(value.page?.next_cursor, null)
  })

  it('rejects self reference, unknown sessions, and out-of-workspace reads', async () => {
    const ctx = await harness()
    makeSession(ctx, 'target', '/w')
    makeSession(ctx, 'other', '/elsewhere')
    appendTurn(ctx, 'other', 'u', 'a')
    const tool = readSessionTool(ctx, fakeAgent(ctx, 'target'), options)
    const self = await tool.execute({ session_id: 'target' }, execFor(ctx, 'target')) as { ok: boolean; code?: string }
    assert.deepEqual({ ok: self.ok, code: self.code }, { ok: false, code: 'self-reference' })
    const ghost = await tool.execute({ session_id: 'ghost' }, execFor(ctx, 'target')) as { ok: boolean; code?: string }
    assert.equal(ghost.ok, false)
    assert.equal(ghost.code, 'session-unavailable')
    const cross = await tool.execute({ session_id: 'other' }, execFor(ctx, 'target')) as { ok: boolean; code?: string }
    assert.deepEqual({ ok: cross.ok, code: cross.code }, { ok: false, code: 'out-of-scope' })
  })

  it('allows cross-workspace reads under the all scope', async () => {
    const ctx = await harness()
    makeSession(ctx, 'target', '/w')
    makeSession(ctx, 'other', '/elsewhere')
    appendTurn(ctx, 'other', 'u', 'a')
    const wide: ReadSessionToolOptions = { maxBytes: 65536, maxTurns: 20, scope: 'all' }
    const tool = readSessionTool(ctx, fakeAgent(ctx, 'target'), wide)
    const value = await tool.execute({ session_id: 'other' }, execFor(ctx, 'target')) as { ok: boolean; page?: { turns: unknown[] } }
    assert.equal(value.ok, true)
    assert.equal(value.page?.turns.length, 2)
  })

  it('requires an agent context', async () => {
    const ctx = await harness()
    makeSession(ctx, 'target', '/w')
    const tool = readSessionTool(ctx, fakeAgent(ctx, 'target'), options)
    const value = await tool.execute({ session_id: 'source' }, { signal: new AbortController().signal } as ToolRunContext) as {
      ok: boolean
      code?: string
    }
    assert.deepEqual({ ok: value.ok, code: value.code }, { ok: false, code: 'context-unavailable' })
  })
})
