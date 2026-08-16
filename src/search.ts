/**
 * File-search plumbing shared by the HTTP search route: ripgrep argument
 * construction (core glob discipline plus query matching), workspace root
 * resolution (primary cwd plus dsh-add-dir added directories), and the pure
 * path helpers used by search and probe routes.
 * @module dsh-at-mention/src/search
 */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { GLOB_VCS_EXCLUDES } from '@deepseek-ai/dsh-tool-fs-search'

/**
 * Directories the file search skips by default (DESIGN §5.2, the Codex
 * desktop's explicit filter list beyond VCS names).
 */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '.next',
  '.pnpm-store',
  '.turbo',
  '.yarn',
  'node_modules',
  'build',
  'coverage',
  'dist',
]

/** Minimal dsh-add-dir registry face (optional cross-plugin integration; no package dependency). */
export interface AddDirRegistryLike {
  byCwd(cwd: string): { record: { dirs: string[] } } | undefined
  statusOf(record: { dirs: string[] }): Map<string, string>
}

/**
 * Escape ripgrep glob metacharacters in a query so user input matches
 * literally.
 * @param query - raw search query.
 * @returns the glob-safe literal.
 */
export function escapeGlobQuery(query: string): string {
  return query.replace(/[\\*?{},[\]]/gu, match => `\\${match}`)
}

/**
 * Build the ripgrep argv for one query over one root. Mirrors the core glob
 * discipline (--hidden, --no-ignore, modified-time sort, double-negated
 * directory excludes) and adds one case-insensitive glob that matches the
 * query in any path segment or as a directory ancestor.
 * @param query - raw search query.
 * @param extraExcludes - additional directory names to exclude.
 * @returns argv without the trailing root path (the caller appends it).
 */
export function buildSearchArgv(query: string, extraExcludes: readonly string[]): string[] {
  const literal = escapeGlobQuery(query)
  const pattern = `{**/*${literal}*,**/*${literal}*/**}`
  const excludes = [...GLOB_VCS_EXCLUDES, ...DEFAULT_EXCLUDES, ...extraExcludes]
  return [
    '--files',
    '--hidden',
    '--no-ignore',
    '--sort=modified',
    ...excludes.flatMap(name => [`--glob=!**/${name}`, `--glob=!**/${name}/**`]),
    `--iglob=${pattern}`,
    '--',
  ]
}

/**
 * Whether target is root itself or lies under root.
 * @param root - absolute root directory.
 * @param target - absolute candidate path.
 * @returns containment verdict.
 */
export function isPathUnder(root: string, target: string): boolean {
  const normalizedRoot = resolve(root)
  const normalizedTarget = resolve(target)
  if (normalizedTarget === normalizedRoot) return true
  return normalizedTarget.startsWith(normalizedRoot + sep)
}

/**
 * Workspace-relative display path for one absolute file, when it lies under
 * a root; the absolute path otherwise.
 * @param root - absolute root directory.
 * @param abs - absolute file path.
 * @returns display path.
 */
export function toDisplayPath(root: string, abs: string): string {
  if (isPathUnder(root, abs)) {
    const rel = relative(resolve(root), resolve(abs))
    return rel.length === 0 ? '.' : rel
  }
  return abs
}

/** One merged search result row. */
export interface FileView {
  /** Absolute file path (the model-visible form). */
  abs: string
  /** Workspace-relative display path. */
  rel: string
  /** Root alias: 主 for the primary directory, the added directory's basename otherwise. */
  root: string
}

/**
 * Resolve the search root set for one session cwd: the primary directory
 * plus every added directory with live ok status.
 * @param ctx - the plugin context (reads the optional add-dir registry).
 * @param cwd - the session working directory.
 * @param includeAddedDirs - whether added directories join the search.
 * @returns absolute root directories, primary first.
 */
export function resolveRoots(ctx: Context, cwd: string, includeAddedDirs: boolean): string[] {
  const roots = [cwd]
  if (!includeAddedDirs) return roots
  const registry = ctx.get('addDirRegistry') as AddDirRegistryLike | undefined
  if (registry === undefined) return roots
  const found = registry.byCwd(cwd)
  if (found === undefined) return roots
  const statuses = registry.statusOf(found.record)
  for (const dir of found.record.dirs) {
    if (statuses.get(dir) === 'ok' && !roots.includes(dir)) roots.push(dir)
  }
  return roots
}

/**
 * Convert one ripgrep output line into its absolute path. Ripgrep prints
 * workdir-relative lines for in-root matches; outside lines arrive absolute
 * and pass through.
 * @param line - one stdout line.
 * @param workdir - the run's resolved workdir.
 * @returns the absolute path.
 */
export function toAbsolutePath(line: string, workdir: string): string {
  return isAbsolute(line) ? line : join(workdir, line)
}

/**
 * Project one absolute path into the file view, choosing the first root that
 * contains it.
 * @param roots - the search root set (primary first).
 * @param abs - absolute file path.
 * @returns the view row.
 */
export function toFileView(roots: readonly string[], abs: string): FileView {
  for (const root of roots) {
    if (isPathUnder(root, abs)) {
      return {
        abs,
        rel: toDisplayPath(root, abs),
        root: root === roots[0] ? '主' : basenameOf(root),
      }
    }
  }
  return { abs, rel: abs, root: '其他' }
}

/** Directory basename, or the root itself for the filesystem root. */
function basenameOf(path: string): string {
  const base = path.split(sep).filter(part => part.length > 0).at(-1)
  return base ?? path
}
