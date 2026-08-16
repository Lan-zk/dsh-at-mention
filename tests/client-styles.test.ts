import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { applyClientStyles, CLIENT_STYLES, CLIENT_STYLE_ID } from '../src/client/styles.ts'

interface FakeStyle {
  dataset: Record<string, string>
  textContent: string
  removed: boolean
  getAttribute(name: string): string | null
  remove(): void
}

interface FakeDocument {
  querySelectorAll(selector: string): HTMLStyleElement[]
  createElement(tag: string): FakeStyle
  head: {
    appendChild(style: FakeStyle): void
  }
}

function installFakeDocument(existing: FakeStyle[] = []): { doc: FakeDocument; appended: FakeStyle[] } {
  const appended: FakeStyle[] = []
  const doc: FakeDocument = {
    querySelectorAll(selector) {
      assert.equal(selector, 'style[data-plugin-css]')
      return existing as unknown as HTMLStyleElement[]
    },
    createElement(tag) {
      assert.equal(tag, 'style')
      const style: FakeStyle = {
        dataset: {},
        textContent: '',
        removed: false,
        getAttribute() {
          return null
        },
        remove() {
          this.removed = true
        },
      }
      return style
    },
    head: {
      appendChild(style) {
        appended.push(style)
      },
    },
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    writable: true,
    value: doc,
  })
  return { doc, appended }
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document')
})

describe('client styles', () => {
  it('keeps the width and chip overrides on stable composer attributes', () => {
    assert.ok(CLIENT_STYLES.includes("[data-composer-card] [role='listbox']:has([data-source])"))
    assert.ok(CLIENT_STYLES.includes("[data-decoration='chip']"))
    assert.ok(CLIENT_STYLES.includes("[data-decoration='text-ref']"))
  })

  it('injects one plugin-owned style tag as a disposable effect', () => {
    const { appended } = installFakeDocument()
    const disposers: Array<() => void> = []
    let label: string | undefined
    applyClientStyles({
      effect(body: () => () => void, effectLabel?: string) {
        label = effectLabel
        disposers.push(body())
      },
    } as unknown as ClientContext)

    assert.equal(label, 'at-mention: client styles')
    assert.equal(appended.length, 1)
    assert.equal(appended[0]?.dataset.plugin, 'dsh-at-mention')
    assert.equal(appended[0]?.dataset.pluginCss, CLIENT_STYLE_ID)
    assert.equal(appended[0]?.textContent, CLIENT_STYLES)

    disposers[0]?.()
    assert.equal(appended[0]?.removed, true)
  })

  it('does not duplicate a style tag left by a previous evaluation', () => {
    const existing: FakeStyle[] = [{
      dataset: { plugin: 'dsh-at-mention', pluginCss: CLIENT_STYLE_ID },
      textContent: CLIENT_STYLES,
      removed: false,
      getAttribute(name) {
        return name === 'data-plugin-css' ? CLIENT_STYLE_ID : null
      },
      remove() {
        this.removed = true
      },
    }]
    const { appended } = installFakeDocument(existing)
    applyClientStyles({ effect(body: () => () => void) { void body() } } as unknown as ClientContext)
    assert.equal(appended.length, 0)
  })
})
