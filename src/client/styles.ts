/**
 * Client-side presentation overrides for the at-mention trigger experience.
 * The candidate popup and the composer chips are rendered by upstream
 * packages, so this plugin contributes a small plugin-owned stylesheet
 * instead of forking their components. Selectors use the stable
 * `data-composer-card` / `data-decoration` attributes published by the
 * composer DOM; no CSS-module hashes are referenced.
 *
 * Chip labels rely on the host's default chip presentation. This plugin
 * deliberately does not restyle `[data-decoration='chip']` globally: those
 * selectors would also affect other plugins' chips, which is exactly the
 * cross-plugin interference this review removed.
 * @module dsh-at-mention/src/client/styles
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Plugin-owned style tag id (`<style data-plugin-css>` value). */
export const CLIENT_STYLE_ID = 'dsh-at-mention/client-styles'

/**
 * Theme-aware presentation overrides.
 *
 * Popup: only a trigger menu containing this plugin's 会话 or 文件 group is
 * stretched to the composer card's border box. On desktop, the primary
 * candidate label receives the remaining row width while trailing metadata
 * stays secondary and capped.
 */
export const CLIENT_STYLES = `
@media (min-width: 768px) {
  [data-composer-card] [role='listbox']:has([data-source='会话'], [data-source='文件']) {
    left: -1px;
    right: -1px;
    width: auto;
    min-width: 0;
    max-width: none;
  }

  [data-composer-card] [role='listbox']:has([data-source='会话'], [data-source='文件'])
    [role='option'] > [aria-hidden] + span {
    flex: 1 1 auto;
    min-width: 0;
    max-width: none;
  }

  [data-composer-card] [role='listbox']:has([data-source='会话'], [data-source='文件'])
    [role='option'] > [aria-hidden] + span + span {
    flex: 0 1 auto;
    max-width: 34%;
  }
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
