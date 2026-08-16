/**
 * dsh-at-mention, browser half: two `@` trigger sources over the input
 * trigger pipeline. 会话 inserts session chips that serialize to the
 * canonical dsh-session mention (existence-probed before send); 文件 inserts
 * live path-reference chips that serialize to the absolute path
 * (existence-probed inside the workspace roots before send). Group titles
 * are hardcoded Chinese source names: the slash.menu locale namespace is
 * single-owner, so a third-party plugin cannot register localized titles
 * (DESIGN §4.5).
 * @module dsh-at-mention/src/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ClientSessionContext,
  InputTriggerCandidate,
  InputTriggerPick,
  InputTriggerServiceContract,
  InputTriggerSource,
  PickOutcome,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { sessionCandidates, fileCandidates } from './candidates.ts'
import type { SessionRowLike } from './candidates.ts'
import { debounce, ApiError, resolveSession, searchFiles, statFile } from './host-api.ts'
import { formatSessionReferenceMention } from './uri.ts'

/** Client-half config slice (validated host-side; read with defaults here). */
export interface ClientConfig {
  /** File-search input debounce in milliseconds. */
  debounceMs?: number
  /** Per-group candidate cap. */
  maxCandidates?: number
  /** Session candidate scope. */
  sessionScope?: 'workspace' | 'all'
}

/** Required services (also the informational dsh.client edges). */
export const inject = ['inputTriggers', 'sessions']

/** A picked file's durable client-side identity: path plus the probe scope. */
interface FileRef {
  abs: string
  rel: string
  cwd: string
}

/**
 * Register the two `@` sources. All registrations ride effects, so unload
 * and HMR leave nothing behind.
 * @param ctx - the client root context.
 * @param config - config slice (defaults applied here).
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  const debounceMs = config.debounceMs ?? 100
  const cap = config.maxCandidates ?? 20
  const scope = config.sessionScope ?? 'workspace'
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract | undefined
  if (inputTriggers === undefined) throw new Error('at-mention: inputTriggers service unavailable')
  ctx.effect(() => inputTriggers.registerSource(sessionSource(ctx, cap, scope)), 'at-mention: 会话 source')
  ctx.effect(() => inputTriggers.registerSource(fileSource(ctx, debounceMs, cap)), 'at-mention: 文件 source')
}

/** Session list rows as the structural face (branded keys erased for lookup). */
function rowsById(ctx: ClientContext): Record<string, SessionRowLike> {
  return ctx.sessions.list.getSnapshot().byId as unknown as Record<string, SessionRowLike>
}

/** Session list rows as the structural face. */
function sessionRows(ctx: ClientContext): SessionRowLike[] {
  return Object.values(rowsById(ctx))
}

/** The composing session's cwd from the list snapshot. */
function cwdOf(ctx: ClientContext, session: ClientSessionContext): string | undefined {
  return rowsById(ctx)[session.sessionId]?.cwd
}

/** Display title of one session, falling back to the id. */
function titleOf(ctx: ClientContext, id: string): string {
  return rowsById(ctx)[id]?.displayTitle ?? id
}

/** Session source: unique-label candidates over the zero-RPC list snapshot. */
function sessionSource(ctx: ClientContext, cap: number, scope: 'workspace' | 'all'): InputTriggerSource {
  const picked = new Map<string, string>()
  return {
    trigger: '@',
    name: '会话',
    order: 0,
    candidates(session, { query }) {
      const rows = sessionRows(ctx)
      const projected = sessionCandidates(rows, session.sessionId, cwdOf(ctx, session), scope, query, cap)
      picked.clear()
      const candidates: InputTriggerCandidate[] = projected.map((candidate) => {
        picked.set(candidate.label, candidate.id)
        return {
          name: candidate.label,
          ...(candidate.description === undefined ? {} : { description: candidate.description }),
          icon: '💬',
        }
      })
      return Promise.resolve(candidates)
    },
    onPick({ candidate }: InputTriggerPick): PickOutcome {
      const id = picked.get(candidate.name)
      if (id === undefined) return undefined
      const label = titleOf(ctx, id)
      return {
        insert: {
          source: '会话',
          ref: id,
          label,
          clipboardText: `@${label}`,
        },
      }
    },
    codec: {
      clipboardText: ref => `@${titleOf(ctx, ref)}`,
      serialize: async (ref, signal) => {
        const label = titleOf(ctx, ref)
        const exists = await resolveSession(ref, signal)
        if (!exists) {
          throw new Error(`引用的会话已不可用（${label}），请移除该引用后重试`)
        }
        return formatSessionReferenceMention(ref, label)
      },
    },
  }
}

/** Parse a file chip ref; malformed refs pass through unchanged on serialize. */
function parseFileRef(ref: string): FileRef | undefined {
  try {
    const value = JSON.parse(ref) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const { abs, rel, cwd } = value as Partial<FileRef>
    if (typeof abs !== 'string' || typeof rel !== 'string' || typeof cwd !== 'string') return undefined
    return { abs, rel, cwd }
  } catch {
    return undefined
  }
}

/** File source: debounced host search with a visible error candidate. */
function fileSource(ctx: ClientContext, debounceMs: number, cap: number): InputTriggerSource {
  const picked = new Map<string, FileRef>()
  const errorCandidate = (message: string): InputTriggerCandidate => ({
    name: '文件搜索暂时不可用',
    description: message,
    icon: '⚠️',
  })
  return {
    trigger: '@',
    name: '文件',
    order: 1,
    async candidates(session, { query, signal }) {
      const trimmed = query.trim()
      if (trimmed.length === 0) return []
      const cwd = cwdOf(ctx, session)
      if (cwd === undefined) return []
      await debounce(signal, debounceMs)
      if (signal.aborted) return []
      let data: { files: Array<{ abs: string; rel: string; root: string }>; truncated: boolean }
      try {
        data = await searchFiles(cwd, trimmed, signal)
      } catch (error: unknown) {
        if (signal.aborted) return []
        if (error instanceof ApiError) return [errorCandidate('请稍后重试')]
        return [errorCandidate(error instanceof Error ? error.message.slice(0, 80) : '请稍后重试')]
      }
      if (signal.aborted) return []
      picked.clear()
      const projected = fileCandidates(data.files, trimmed, cap)
      return projected.map((candidate) => {
        picked.set(candidate.name, { abs: candidate.abs, rel: candidate.rel, cwd })
        return {
          name: candidate.name,
          ...(candidate.description === undefined ? {} : { description: candidate.description }),
          icon: candidate.icon,
        }
      })
    },
    onPick({ candidate }: InputTriggerPick): PickOutcome {
      if (candidate.icon === '⚠️') return 'handled'
      const file = picked.get(candidate.name)
      if (file === undefined) return undefined
      return {
        insert: {
          source: '文件',
          ref: JSON.stringify(file),
          label: file.rel,
          clipboardText: file.rel,
        },
      }
    },
    codec: {
      clipboardText: ref => parseFileRef(ref)?.rel ?? ref,
      serialize: async (ref, signal) => {
        const file = parseFileRef(ref)
        if (file === undefined) return ref
        const exists = await statFile(file.cwd, file.abs, signal)
        if (!exists) {
          throw new Error(`引用的文件已不存在或已移动（${file.rel}），请移除该引用后重试`)
        }
        return file.abs
      },
    },
  }
}
