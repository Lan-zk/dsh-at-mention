import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanEncodedReferences,
  encodeFileReference,
  encodeSessionReference,
  parseEncodedReferences,
  REF_MARK,
} from '../src/shared/reference-format.ts'

describe('reference-format', () => {
  it('encodes and parses a file reference with full visible label', () => {
    const text = encodeFileReference('DESIGN.zh.md', '/w/DESIGN.zh.md')
    assert.equal(text, `@DESIGN.zh.md${REF_MARK}f:${encodeURIComponent('/w/DESIGN.zh.md')}${REF_MARK}`)
    const [ref] = parseEncodedReferences(`before ${text} after`)
    assert.equal(ref?.type, 'file')
    assert.equal(ref?.label, 'DESIGN.zh.md')
    assert.equal(ref?.ref, '/w/DESIGN.zh.md')
    assert.equal(ref?.start, 7)
    assert.equal(ref?.visibleEnd, 7 + '@DESIGN.zh.md'.length)
    assert.equal(ref?.end, 7 + text.length)
  })

  it('encodes and parses a session reference with spaces and unicode', () => {
    const label = '需求 讨论'
    const text = encodeSessionReference(label, 'sess-1')
    const [ref] = parseEncodedReferences(text)
    assert.equal(ref?.type, 'session')
    assert.equal(ref?.label, label)
    assert.equal(ref?.ref, 'sess-1')
  })

  it('cleans encoded references to model-facing text', () => {
    const file = encodeFileReference('a/b.ts', '/w/a/b.ts')
    const session = encodeSessionReference('会话', 's1')
    assert.equal(
      cleanEncodedReferences(`see ${file} and ${session}`),
      'see /w/a/b.ts and @会话',
    )
  })

  it('ignores malformed or plain text without markers', () => {
    assert.deepEqual(parseEncodedReferences('@DESIGN.zh.md'), [])
    assert.deepEqual(parseEncodedReferences('@a\u2063x:y\u2063'), [])
  })
})
