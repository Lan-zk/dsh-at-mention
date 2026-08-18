/**
 * Pure candidate projection shared by the two `@` sources. Session rows come
 * from the client session-list snapshot (zero RPC); file rows come from the
 * host search route. All ranking and disambiguation rules from DESIGN §4.2
 * live here as pure functions.
 * @module dsh-at-mention/src/client/candidates
 */

/** Structural session-row face (the client list snapshot). */
export interface SessionRowLike {
  id: string
  displayTitle: string
  cwd?: string
  parentId?: string
  running: boolean
  blank: boolean
  updatedAt: number
}

/** One projected session candidate. */
export interface SessionCandidate {
  /** Unique display label (duplicate titles carry a short-id suffix). */
  label: string
  description?: string
  id: string
}

/** One projected file candidate. */
export interface FileCandidate {
  /** Unique display name (duplicate basenames carry a directory/root alias). */
  name: string
  description?: string
  icon: string
  abs: string
  rel: string
}

/** Case-insensitive match strength: path prefix, segment prefix, substring. */
function matchScore(displayTitle: string, query: string): number {
  const title = displayTitle.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  if (title.startsWith(needle)) return 2
  if (title.includes(needle)) return 1
  return 0
}

/**
 * Project session candidates for one query. Excludes self and blank rows;
 * workspace scope keeps same-cwd rows, all scope ranks same-cwd > no-cwd >
 * other-cwd. Empty query returns the most recent three rows.
 * @param rows - the session list snapshot rows.
 * @param currentId - the composing session.
 * @param currentCwd - the composing session's cwd.
 * @param scope - workspace or all.
 * @param query - raw query.
 * @param cap - inclusive result cap.
 */
export function sessionCandidates(
  rows: readonly SessionRowLike[],
  currentId: string,
  currentCwd: string | undefined,
  scope: 'workspace' | 'all',
  query: string,
  cap: number,
): SessionCandidate[] {
  const eligible = rows.filter(row => row.id !== currentId && !row.blank)
  const trimmed = query.trim()
  const scoped = eligible.filter(row => {
    if (trimmed.length > 0 && matchScore(row.displayTitle, trimmed) === 0) return false
    if (scope === 'workspace') return row.cwd === currentCwd
    return true
  })
  const ranked = scoped.toSorted((a, b) => {
    if (trimmed.length > 0) {
      const scoreDelta = matchScore(b.displayTitle, trimmed) - matchScore(a.displayTitle, trimmed)
      if (scoreDelta !== 0) return scoreDelta
    }
    if (scope === 'all') {
      const groupOf = (row: SessionRowLike): number => row.cwd === currentCwd ? 0 : row.cwd === undefined ? 1 : 2
      const groupDelta = groupOf(a) - groupOf(b)
      if (groupDelta !== 0) return groupDelta
    }
    return b.updatedAt - a.updatedAt
  })
  const capped = ranked.slice(0, trimmed.length === 0 ? Math.min(cap, 3) : cap)
  const titles = new Map<string, number>()
  for (const row of capped) titles.set(row.displayTitle, (titles.get(row.displayTitle) ?? 0) + 1)
  return capped.map((row) => {
    const duplicate = (titles.get(row.displayTitle) ?? 0) > 1
    const label = duplicate ? `${row.displayTitle} · ${row.id.slice(-6)}` : row.displayTitle
    const badges: string[] = []
    if (row.running) badges.push('运行中')
    if (row.parentId !== undefined) badges.push('子智能体')
    if (trimmed.length === 0) badges.push('最近')
    if (scope === 'all' && row.cwd !== currentCwd) badges.push(row.cwd ?? '无工作目录')
    return {
      label,
      ...(badges.length > 0 ? { description: badges.join(' · ') } : {}),
      id: row.id,
    }
  })
}

/** Display form of a file row: forward slashes regardless of host platform. */
function displayPathOf(rel: string): string {
  return rel.replaceAll('\\', '/')
}

/** Basename of a display path. */
function basenameOf(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1)
}

/** Inclusive-match strength over a display path. */
function pathScore(rel: string, query: string): number {
  const path = rel.toLocaleLowerCase()
  const needle = query.toLocaleLowerCase()
  if (path.startsWith(needle)) return 2
  const lastSegment = basenameOf(path)
  if (lastSegment.startsWith(needle)) return 1
  return 0
}

/** Directory depth of a display path. */
function depthOf(rel: string): number {
  return rel.split('/').length - 1
}

/** Parent directory of a display path, or undefined for a top-level file. */
function dirOf(rel: string): string | undefined {
  const slash = rel.lastIndexOf('/')
  return slash < 0 ? undefined : rel.slice(0, slash)
}

/**
 * Project file candidates over one host search response. Ranks prefix >
 * segment prefix > depth, clusters primary-root rows first, and keeps the
 * host's modified-time order as the stable tiebreak. Display paths are
 * normalized to forward slashes so ranking and descriptions work on Windows.
 * The primary label is the basename; duplicate basenames are disambiguated
 * with the parent directory (or the root alias when the directory is shared).
 * @param rows - host search rows.
 * @param query - the query that produced them.
 * @param cap - inclusive result cap.
 */
export function fileCandidates(
  rows: readonly { abs: string; rel: string; root: string }[],
  query: string,
  cap: number,
): FileCandidate[] {
  const roots = [...new Set(rows.map(row => row.root))]
  const multiRoot = roots.length > 1
  const baseCounts = new Map<string, number>()
  const dirCounts = new Map<string, number>()
  for (const row of rows) {
    const rel = displayPathOf(row.rel)
    const base = basenameOf(rel)
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)
    const dir = dirOf(rel)
    if (dir !== undefined) {
      const key = `${base}|${dir}`
      dirCounts.set(key, (dirCounts.get(key) ?? 0) + 1)
    }
  }
  const rootOrder = (root: string): number => (root === '主' ? 0 : 1)
  const ranked = rows.toSorted((a, b) => {
    const relA = displayPathOf(a.rel)
    const relB = displayPathOf(b.rel)
    const scoreDelta = pathScore(relB, query) - pathScore(relA, query)
    if (scoreDelta !== 0) return scoreDelta
    const rootDelta = rootOrder(a.root) - rootOrder(b.root)
    if (rootDelta !== 0) return rootDelta
    return depthOf(relA) - depthOf(relB)
  })
  return ranked.slice(0, cap).map((row) => {
    const rel = displayPathOf(row.rel)
    const base = basenameOf(rel)
    const dir = dirOf(rel)
    const dupBase = (baseCounts.get(base) ?? 0) > 1
    const dupDirAcrossRoots = dupBase && dir !== undefined && (dirCounts.get(`${base}|${dir}`) ?? 0) > 1
    const name = dupBase
      ? dir !== undefined && !dupDirAcrossRoots ? `${base} · ${dir}` : `${base} · ${row.root}`
      : base
    return {
      name,
      ...(multiRoot || dir !== undefined ? {
        description: [multiRoot ? row.root : undefined, dir].filter((part): part is string => part !== undefined).join(' · '),
      } : {}),
      icon: '📄',
      abs: row.abs,
      rel,
    }
  })
}
