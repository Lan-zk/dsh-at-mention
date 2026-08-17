/**
 * Shared wire format for plain-text at-mention references.
 *
 * The client inserts a visually normal `@label` followed by an invisible
 * metadata suffix:
 *
 *   @DESIGN.zh.md\u2063f:%2Fabs%2Fpath\u2063
 *   @Some Session\u2063s:session-id\u2063
 *
 * The suffix is invisible in the composer, lets the client treat the whole
 * reference as one atomic unit for caret/delete/click, and lets the host
 * consumer restore the original model projection (absolute file path or
 * canonical session mention) without relying on the chip occurrence table.
 * @module dsh-at-mention/src/shared/reference-format
 */

/** Invisible separator used around the encoded payload. */
export const REF_MARK = '\u2063'

/** One parsed plain-text reference. */
export interface EncodedReference {
  readonly type: 'file' | 'session'
  /** Visible label, without the leading `@`. */
  readonly label: string
  /** Decoded payload: absolute path for files, session id for sessions. */
  readonly ref: string
  /** Offset of the leading `@` in the source text. */
  readonly start: number
  /** Offset just past the trailing invisible marker. */
  readonly end: number
  /** Offset just past the visible `@label` (before the invisible suffix). */
  readonly visibleEnd: number
}

const PATTERN = /@([^\u2063\n]*?)\u2063([fs]):([^\u2063]+)\u2063/gu

function decodePayload(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

/**
 * Encode a file reference as visible `@rel` plus an invisible absolute-path
 * payload.
 */
export function encodeFileReference(rel: string, abs: string): string {
  return `@${rel}${REF_MARK}f:${encodeURIComponent(abs)}${REF_MARK}`
}

/**
 * Encode a session reference as visible `@label` plus an invisible session-id
 * payload.
 */
export function encodeSessionReference(label: string, id: string): string {
  return `@${label}${REF_MARK}s:${encodeURIComponent(id)}${REF_MARK}`
}

/**
 * Parse every encoded at-mention reference in a draft. Ranges are in
 * JavaScript string offsets and include the invisible suffix.
 */
export function parseEncodedReferences(text: string): EncodedReference[] {
  const out: EncodedReference[] = []
  PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = PATTERN.exec(text)) !== null) {
    const label = match[1] ?? ''
    const type = match[2] === 'f' ? 'file' : match[2] === 's' ? 'session' : undefined
    const payload = match[3]
    if (type === undefined || payload === undefined) continue
    const ref = decodePayload(payload)
    if (ref === undefined) continue
    const start = match.index
    out.push({
      type,
      label,
      ref,
      start,
      end: start + match[0].length,
      visibleEnd: start + 1 + label.length,
    })
  }
  return out
}

/**
 * Replace encoded references with their model-facing projection:
 * files become the absolute path, sessions become readable `@label`.
 */
export function cleanEncodedReferences(text: string): string {
  return text.replace(PATTERN, (whole, label: string, type: string, payload: string) => {
    const ref = decodePayload(payload)
    if (ref === undefined) return whole
    return type === 'f' ? ref : `@${label}`
  })
}
