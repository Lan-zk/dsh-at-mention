/**
 * dsh-at-mention: `@` context references for the dsh web composer.
 * One `@` source searches workspace files (live path references); the other
 * references other sessions in the same workspace. Session references are
 * consumed at `agent/pre-step`: the mention URI is replaced by a readable
 * `@label` and, in snapshot mode, the bounded surface snapshot is injected
 * as an untrusted context message before the user's message.
 * @module dsh-at-mention
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import { applyApi } from './api.ts'
import { applyConsumer } from './consumer.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'at-mention'

/** Services required before the plugin starts. */
export const inject = ['webServer']

/** Plugin config (all optional — Config supplies the defaults). */
export interface Config {
  /** File-search input debounce in milliseconds (client half). */
  debounceMs?: number
  /** Per-group candidate cap (client half). */
  maxCandidates?: number
  /** File search surface. */
  fileSearch?: {
    /** Inclusive host-side cap on search results. */
    maxResults?: number
    /** Extra ripgrep exclusion globs, e.g. "vendor". */
    excludePatterns?: string[]
    /** Fan the search out across added directories (dsh-add-dir). */
    includeAddedDirs?: boolean
  }
  /** Session candidate scope: workspace (same cwd) or every local session. */
  sessionScope?: 'workspace' | 'all'
  /** Session reference resolution: eager snapshot (v1) or lazy read tool (M5). */
  sessionReferenceMode?: 'snapshot' | 'reference'
  /** UTF-8 byte budget per referenced-session snapshot. */
  maxReferenceBytes?: number
  /** Inclusive maximum of distinct referenced sessions per message. */
  maxReferences?: number
  /** Lazy read_session tool paging (M5). */
  readPage?: {
    /** UTF-8 byte budget per tool page. */
    maxBytes?: number
    /** Inclusive maximum of turns per tool page. */
    maxTurns?: number
  }
}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  debounceMs: z.number().step(1).min(50).max(500).default(100),
  maxCandidates: z.number().step(1).min(1).max(50).default(20),
  fileSearch: z.object({
    maxResults: z.number().step(1).min(1).max(500).default(100),
    excludePatterns: z.array(z.string()).default([]),
    includeAddedDirs: z.boolean().default(true),
  }).default({ maxResults: 100, excludePatterns: [], includeAddedDirs: true }),
  sessionScope: z.union(['workspace', 'all'] as const).default('workspace'),
  sessionReferenceMode: z.union(['snapshot', 'reference'] as const).default('snapshot'),
  maxReferenceBytes: z.number().step(1).min(1).default(65536),
  maxReferences: z.number().step(1).min(1).max(3).default(3),
  readPage: z.object({
    maxBytes: z.number().step(1).min(1).default(65536),
    maxTurns: z.number().step(1).min(1).max(100).default(20),
  }).default({ maxBytes: 65536, maxTurns: 20 }),
})

/** Validated config with Schemastery defaults applied. */
export interface ResolvedConfig {
  debounceMs: number
  maxCandidates: number
  fileSearch: {
    maxResults: number
    excludePatterns: string[]
    includeAddedDirs: boolean
  }
  sessionScope: 'workspace' | 'all'
  sessionReferenceMode: 'snapshot' | 'reference'
  maxReferenceBytes: number
  maxReferences: number
  readPage: {
    maxBytes: number
    maxTurns: number
  }
}

/**
 * Mount the session-reference resolver, the pre-step consumer, and the HTTP
 * surface. Every registration is an effect, so unload and HMR leave nothing
 * behind.
 * @param ctx - the plugin context.
 * @param config - schemastery-validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = config as ResolvedConfig
  await ctx.plugin(SessionReferenceResolver, {
    maxReferenceBytes: resolved.maxReferenceBytes,
    maxReferences: resolved.maxReferences,
  })
  const resolver = ctx.get('sessionReferenceResolver')
  if (resolver === undefined) {
    throw new Error('at-mention: sessionReferenceResolver is unavailable after mounting')
  }
  applyConsumer(ctx, resolver, {
    mode: resolved.sessionReferenceMode,
    maxReferences: resolved.maxReferences,
  })
  applyApi(ctx, resolved)
}
