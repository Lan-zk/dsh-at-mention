import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodeSessionReferenceUri,
  encodeSessionReferenceUri as hostEncode,
  formatSessionReferenceMention as hostFormat,
} from '@deepseek-ai/dsh-session-reference'
import {
  encodeSessionReferenceUri,
  escapeLabel,
  formatSessionReferenceMention,
} from '../src/client/uri.ts'

/** Session ids hostile to base64url/UTF-8 handling. */
const SAMPLE_IDS = [
  'plain-session',
  '会话-引用 测试',
  'quote"back\\slash',
  'emoji-🚀-mix',
  '中文括号（与）符号[]{}',
  String.fromCharCode(0x80, 0x81),
]

describe('client URI codec vs host', () => {
  it('produces byte-identical canonical URIs for hostile ids', () => {
    for (const id of SAMPLE_IDS) {
      assert.equal(encodeSessionReferenceUri(id), hostEncode(id as never), `mismatch for ${id}`)
    }
  })

  it('round-trips through the host decoder (canonical self-check)', () => {
    for (const id of SAMPLE_IDS) {
      const uri = encodeSessionReferenceUri(id)
      assert.equal(String(decodeSessionReferenceUri(uri)), id)
    }
  })
})

describe('client mention formatting vs host', () => {
  it('escapes labels exactly like the host formatter', () => {
    const cases = ['plain', '带]括号', '反\\斜杠', 'both]\\here']
    for (const label of cases) {
      assert.equal(escapeLabel(label), hostFormat({ sessionId: 's' as never, label }).match(/^@\[(.*)\]\(/u)?.[1])
    }
  })

  it('formats the full mention byte-identically', () => {
    assert.equal(
      formatSessionReferenceMention('s1', '源]会话'),
      hostFormat({ sessionId: 's1' as never, label: '源]会话' }),
    )
  })
})
