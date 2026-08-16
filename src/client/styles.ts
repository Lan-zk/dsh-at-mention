/**
 * Client-side presentation overrides for the at-mention trigger experience.
 * The candidate popup and the composer chips are rendered by upstream
 * packages, so this plugin contributes a small plugin-owned stylesheet
 * instead of forking their components. Selectors use the stable
 * `data-composer-card` / `data-decoration` attributes published by the
 * composer DOM; no CSS-module hashes are referenced.
 * @module dsh-at-mention/src/client/styles
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Plugin-owned style tag id (`<style data-plugin-css>` value). */
export const CLIENT_STYLE_ID = 'dsh-at-mention/client-styles'

/**
 * Theme-aware presentation overrides.
 *
 * Popup: the trigger menu is the only listbox inside `data-composer-card`
 * that contains `data-source` group rows. Making its left/right edges reach
 * 1px past the zero-height overlay anchor stretches it to the composer
 * card's border box — visually the same width as the current session input.
 *
 * Chips/text refs: reference chips have a fixed U+FFFC advance that must not
 * change, so only paint properties (background, inner shadow, radius) are
 * overridden on the chip and typography is adjusted on the absolutely
 * positioned label overlay. Plain-text references likewise receive only
 * non-layout background paint to avoid drifting the backdrop from the
 * textarea glyphs.
 */
export const CLIENT_STYLES = `
[data-composer-card] [role='listbox']:has([data-source]) {
  left: -1px;
  right: -1px;
  width: auto;
  min-width: 0;
  max-width: none;
}

[data-composer-card] [data-decoration='chip'] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-business-primary) 28%, transparent);
  border-radius: 7px;
}

[data-composer-card] [data-decoration='chip'] > span {
  color: var(--dsw-alias-state-business-primary);
  font-size: 18px;
  font-weight: 500;
  letter-spacing: 0.2px;
}

[data-composer-card] [data-decoration='chip'][data-invalid] {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dsw-alias-state-error-primary) 28%, transparent);
  text-decoration: none;
}

[data-composer-card] [data-decoration='chip'][data-invalid] > span {
  color: var(--dsw-alias-state-error-primary);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}

[data-composer-card] [data-decoration='text-ref'] {
  background-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 9%, transparent);
  border-radius: 4px;
  box-decoration-break: clone;
  -webkit-box-decoration-break: clone;
}
`

/**
 * Inject the plugin-owned stylesheet as a fiber effect. The tag carries
 * `data-plugin` so the client module loader/HMR layer can remove it with the
 * rest of this plugin's owned styles; the local disposer also removes it
 * when this plugin fiber is unloaded.
 * @param ctx - client root context (effect host).
 */
export function applyClientStyles(ctx: ClientContext): void {
  ctx.effect(() => {
    if (typeof document === 'undefined') return () => {}
    const existing = findStyle(CLIENT_STYLE_ID)
    if (existing !== null) return () => {}
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-at-mention'
    style.dataset.pluginCss = CLIENT_STYLE_ID
    style.textContent = CLIENT_STYLES
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'at-mention: client styles')
}

/** Find a previously injected style tag by its `data-plugin-css` id. */
function findStyle(id: string): HTMLStyleElement | null {
  for (const element of document.querySelectorAll('style[data-plugin-css]')) {
    if (element.getAttribute('data-plugin-css') === id) return element as HTMLStyleElement
  }
  return null
}
