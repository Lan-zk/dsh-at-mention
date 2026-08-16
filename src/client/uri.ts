/**
 * Browser-safe reimplementation of the host session-reference URI codec
 * (host: Buffer base64url; browser: TextEncoder + btoa base64url). Byte
 * output must match the host exactly — the cross-end round-trip is pinned by
 * tests against the published package.
 * @module dsh-at-mention/src/client/uri
 */

const SCHEME = 'dsh-session:'

/** UTF-8 string to the binary form btoa accepts, chunked past the spread limit. */
function utf8Binary(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return binary
}

/**
 * Canonical `dsh-session:` URI for one session id, byte-identical to the host
 * encoder.
 * @param sessionId - opaque session id.
 * @returns canonical URI.
 */
export function encodeSessionReferenceUri(sessionId: string): string {
  const payload = btoa(utf8Binary(JSON.stringify(sessionId)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
  return `${SCHEME}${payload}`
}

/** Escape a mention label exactly like the host formatter. */
export function escapeLabel(label: string): string {
  return label.replace(/[\\\]]/gu, match => `\\${match}`)
}

/**
 * Host-neutral Markdown mention carrying the canonical URI.
 * @param sessionId - opaque session id.
 * @param label - display label.
 * @returns `@[label](dsh-session:…)` mention.
 */
export function formatSessionReferenceMention(sessionId: string, label: string): string {
  return `@[${escapeLabel(label)}](${encodeSessionReferenceUri(sessionId)})`
}
