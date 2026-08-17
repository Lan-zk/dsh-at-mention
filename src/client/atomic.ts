/**
 * Client-side atomicity and plain-text presentation for at-mention
 * references.
 *
 * The upstream composer's plain-text reference path renders literal text but
 * has no occurrence identity, so deletion/caret would normally operate one
 * character at a time. This module adds the missing block behaviour on top of
 * the textarea:
 *
 * - Backspace/Delete removes the whole encoded reference (including its
 *   invisible metadata suffix).
 * - Arrow keys skip over a reference as if it were one character.
 * - Clicking inside a reference selects the whole reference.
 * - The backdrop is decorated with coloured spans so files and sessions are
 *   visually distinct while remaining plain text.
 *
 * All DOM work is scoped to `[data-composer-card]` and disposed with the
 * plugin fiber.
 * @module dsh-at-mention/src/client/atomic
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { parseEncodedReferences } from './reference-format.ts'
import type { EncodedReference } from './reference-format.ts'

/** File reference colour (requested). */
export const FILE_COLOR = '#689efe'
/** Session reference colour, derived from the file colour. */
export const SESSION_COLOR = '#9e8cfe'

const CARD_SELECTOR = '[data-composer-card]'
const BACKDROP_SELECTOR = `${CARD_SELECTOR} [data-input-backdrop]`
const DECORATION_ATTR = 'data-at-ref'
const TYPE_ATTR = 'data-at-type'

function isComposerTextarea(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.closest(CARD_SELECTOR) !== null
}

function selection(el: HTMLTextAreaElement): { start: number; end: number } {
  return {
    start: el.selectionStart ?? 0,
    end: el.selectionEnd ?? el.selectionStart ?? 0,
  }
}

function setSelection(el: HTMLTextAreaElement, start: number, end = start): void {
  el.setSelectionRange(start, end)
}

function commitEdit(el: HTMLTextAreaElement, next: string, caret: number): void {
  el.value = next
  setSelection(el, caret)
  el.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    inputType: 'deleteContentBackward',
  }))
}

/** Find the reference range that should be deleted for a given caret/key. */
function rangeForDelete(ranges: readonly EncodedReference[], caret: number, backward: boolean): EncodedReference | undefined {
  for (const range of ranges) {
    if (backward) {
      if (caret > range.start && caret <= range.end) return range
    } else if (caret >= range.start && caret < range.end) {
      return range
    }
  }
  return undefined
}

/** Expand a selection to cover every reference it intersects. */
function expandToReferences(
  ranges: readonly EncodedReference[],
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  let changed = false
  let min = start
  let max = end
  for (const range of ranges) {
    if (start < range.end && end > range.start) {
      min = Math.min(min, range.start)
      max = Math.max(max, range.end)
      changed = true
    }
  }
  return changed ? { start: min, end: max } : undefined
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return
  if (!isComposerTextarea(event.target)) return
  const el = event.target
  if (el.readOnly || el.disabled) return
  const ranges = parseEncodedReferences(el.value)
  if (ranges.length === 0) return

  const { start, end } = selection(el)
  const key = event.key

  if (key === 'Backspace' || key === 'Delete') {
    const backward = key === 'Backspace'
    let deleteStart: number | undefined
    let deleteEnd: number | undefined
    if (start === end) {
      const range = rangeForDelete(ranges, start, backward)
      if (range === undefined) return
      deleteStart = range.start
      deleteEnd = range.end
    } else {
      const expanded = expandToReferences(ranges, start, end)
      if (expanded === undefined) return
      deleteStart = expanded.start
      deleteEnd = expanded.end
    }
    event.preventDefault()
    commitEdit(el, el.value.slice(0, deleteStart) + el.value.slice(deleteEnd), deleteStart)
    return
  }

  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    if (start !== end) return
    const pos = start
    for (const range of ranges) {
      if (key === 'ArrowLeft' && pos > range.start && pos <= range.end) {
        event.preventDefault()
        setSelection(el, range.start)
        return
      }
      if (key === 'ArrowRight' && pos >= range.start && pos < range.end) {
        event.preventDefault()
        setSelection(el, range.end)
        return
      }
    }
  }
}

function handleMouseUp(event: MouseEvent): void {
  if (!isComposerTextarea(event.target)) return
  const el = event.target
  if (el.readOnly || el.disabled) return
  const { start, end } = selection(el)
  if (start !== end) return
  const ranges = parseEncodedReferences(el.value)
  for (const range of ranges) {
    if (start >= range.start && start <= range.end) {
      // Clicking on the invisible suffix should still select the whole ref.
      if (start === range.end) continue
      setSelection(el, range.start, range.end)
      return
    }
  }
}

/** Remove previously injected decoration spans. */
function clearDecorations(container: HTMLElement): void {
  for (const span of Array.from(container.querySelectorAll<HTMLElement>(`[${DECORATION_ATTR}]`))) {
    const parent = span.parentNode
    if (parent === null) continue
    const text = document.createTextNode(span.textContent ?? '')
    parent.replaceChild(text, span)
  }
}

interface TextNodeRef {
  node: Text
  start: number
  end: number
}

function collectTextNodes(container: HTMLElement): TextNodeRef[] {
  const nodes: TextNodeRef[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let offset = 0
  let current: Node | null = walker.nextNode()
  while (current !== null) {
    const node = current as Text
    const length = node.data.length
    nodes.push({ node, start: offset, end: offset + length })
    offset += length
    current = walker.nextNode()
  }
  return nodes
}

function findNodeOffset(nodes: readonly TextNodeRef[], offset: number): { node: Text; offset: number } | null {
  for (const item of nodes) {
    if (offset >= item.start && offset <= item.end) {
      return { node: item.node, offset: offset - item.start }
    }
  }
  return null
}

function decorateBackdrop(container: HTMLElement): void {
  clearDecorations(container)
  const text = container.textContent ?? ''
  const ranges = parseEncodedReferences(text)
  if (ranges.length === 0) return

  const nodes = collectTextNodes(container)
  // Process from last to first so earlier offsets stay valid after DOM edits.
  const ordered = [...ranges].sort((a, b) => b.start - a.start)
  for (const range of ordered) {
    if (range.visibleEnd <= range.start) continue
    const startPoint = findNodeOffset(nodes, range.start)
    const endPoint = findNodeOffset(nodes, range.visibleEnd)
    if (startPoint === null || endPoint === null) continue
    const domRange = document.createRange()
    domRange.setStart(startPoint.node, startPoint.offset)
    domRange.setEnd(endPoint.node, endPoint.offset)
    const span = document.createElement('span')
    span.setAttribute(DECORATION_ATTR, 'true')
    span.setAttribute(TYPE_ATTR, range.type)
    span.style.color = range.type === 'file' ? FILE_COLOR : SESSION_COLOR
    try {
      domRange.surroundContents(span)
    } catch {
      const fragment = domRange.extractContents()
      span.appendChild(fragment)
      domRange.insertNode(span)
    }
  }
}

function decorateAll(): void {
  for (const container of Array.from(document.querySelectorAll<HTMLElement>(BACKDROP_SELECTOR))) {
    decorateBackdrop(container)
  }
}

/**
 * Install atomic editing and visual decoration. Must be called from the
 * client apply path; disposal removes all listeners and observer.
 */
export function applyAtomicReferences(ctx: ClientContext): void {
  ctx.effect(() => {
    if (typeof document === 'undefined' || document.body === null) return () => {}
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('mouseup', handleMouseUp, true)

    let raf = 0
    let decorating = false
    const observer = new MutationObserver(() => {
      // React re-renders the backdrop frequently; coalesce decoration work.
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        if (decorating) return
        decorating = true
        observer.disconnect()
        try {
          decorateAll()
        } finally {
          observer.observe(document.body, { childList: true, subtree: true })
          decorating = false
        }
      })
    })
    decorateAll()
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
    }
  }, 'at-mention: atomic references')
}
