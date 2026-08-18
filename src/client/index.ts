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
import { applyClientStyles } from './styles.ts'
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

/** A picked session's durable client-side identity plus the chosen label. */
interface SessionRef {
  id: string
  label: string
}

/** A picked file's durable client-side identity: path plus the chosen label. */
interface FileRef {
  abs: string
  rel: string
  cwd: string
  label: string
}

/** Parse a session chip ref; malformed refs are rejected by codec serialize. */
function parseSessionRef(ref: string): SessionRef | undefined {
  try {
    const value = JSON.parse(ref) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const { id, label } = value as Partial<SessionRef>
    if (typeof id !== 'string' || typeof label !== 'string') return undefined
    return { id, label }
  } catch {
    return undefined
  }
}

/** Parse a file chip ref; malformed refs pass through unchanged on serialize. */
function parseFileRef(ref: string): FileRef | undefined {
  try {
    const value = JSON.parse(ref) as unknown
    if (typeof value !== 'object' || value === null) return undefined
    const { abs, rel, cwd, label } = value as Partial<FileRef>
    if (typeof abs !== 'string' || typeof rel !== 'string' || typeof cwd !== 'string' || typeof label !== 'string') return undefined
    return { abs, rel, cwd, label }
  } catch {
    return undefined
  }
}

/**
 * Register the two `@` sources. All registrations ride effects, so unload
 * and HMR leave nothing behind.
 * @param ctx - the client root context.
 * @param config - config slice (defaults applied here).
 */
export function apply(ctx: ClientContext, config: ClientConfig = {}): void {
  applyClientStyles(ctx)
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

/** Session source: unique-label candidates over the zero-RPC list snapshot. */
function sessionSource(ctx: ClientContext, cap: number, scope: 'workspace' | 'all'): InputTriggerSource {
  const picked = new Map<string, SessionRef>()
  return {
    trigger: '@',
    name: '会话',
    order: 0,
    candidates(session, { query }) {
      const rows = sessionRows(ctx)
      const projected = sessionCandidates(rows, session.sessionId, cwdOf(ctx, session), scope, query, cap)
      picked.clear()
      const candidates: InputTriggerCandidate[] = projected.map((candidate) => {
        picked.set(candidate.label, { id: candidate.id, label: candidate.label })
        return {
          name: candidate.label,
          ...(candidate.description === undefined ? {} : { description: candidate.description }),
          icon: '💬',
        }
      })
      return Promise.resolve(candidates)
    },
    onPick({ candidate }: InputTriggerPick): PickOutcome {
      const ref = picked.get(candidate.name)
      if (ref === undefined) return undefined
      return {
        insert: {
          source: '会话',
          ref: JSON.stringify(ref),
          label: ref.label,
          clipboardText: `@${ref.label}`,
        },
      }
    },
    codec: {
      clipboardText: ref => {
        const parsed = parseSessionRef(ref)
        return parsed === undefined ? ref : `@${parsed.label}`
      },
      serialize: async (ref, signal) => {
        const parsed = parseSessionRef(ref)
        if (parsed === undefined) throw new Error(`引用的会话格式已损坏，请移除该引用后重试`)
        const exists = await resolveSession(parsed.id, signal)
        if (!exists) {
          throw new Error(`引用的会话已不可用（${parsed.label}），请移除该引用后重试`)
        }
        return formatSessionReferenceMention(parsed.id, parsed.label)
      },
    },
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
      if (cwd === undefined) return [errorCandidate('当前会话没有可搜索的工作目录')]
      await debounce(signal, debounceMs)
      if (signal.aborted) return []
      let data: { files: Array<{ abs: string; rel: string; root: string }>; truncated: boolean }
      try {
        data = await searchFiles(cwd, trimmed, signal)
      } catch (error: unknown) {
        if (signal.aborted) return []
        // Surface the real failure: the host error code/message rides the
        // candidate description so the menu itself is the triage surface.
        const detail = error instanceof ApiError
          ? `${error.code} · ${error.message}`
          : error instanceof Error
            ? error.message.slice(0, 120)
            : '未知错误'
        return [errorCandidate(detail)]
      }
      if (signal.aborted) return []
      picked.clear()
      const projected = fileCandidates(data.files, trimmed, cap)
      const candidates = projected.map((candidate) => {
        picked.set(candidate.name, { abs: candidate.abs, rel: candidate.rel, cwd, label: candidate.name })
        return {
          name: candidate.name,
          ...(candidate.description === undefined ? {} : { description: candidate.description }),
          icon: candidate.icon,
        }
      })
      if (data.truncated) {
        candidates.push({
          name: '结果过多，请细化关键词',
          description: `仅显示前 ${projected.length} 条`,
          icon: '⚠️',
        })
      }
      return candidates
    },
    onPick({ candidate }: InputTriggerPick): PickOutcome {
      if (candidate.icon === '⚠️') return 'handled'
      const file = picked.get(candidate.name)
      if (file === undefined) return undefined
      return {
        insert: {
          source: '文件',
          ref: JSON.stringify(file),
          label: file.label,
          clipboardText: file.label,
        },
      }
    },
    codec: {
      clipboardText: ref => parseFileRef(ref)?.label ?? ref,
      serialize: async (ref, signal) => {
        const file = parseFileRef(ref)
        if (file === undefined) return ref
        const exists = await statFile(file.cwd, file.abs, signal)
        if (!exists) {
          throw new Error(`引用的文件已不存在或已移动（${file.label}），请移除该引用后重试`)
        }
        return file.abs
      },
    },
  }
}
