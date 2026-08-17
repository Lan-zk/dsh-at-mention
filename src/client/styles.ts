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
 * Popup: only a trigger menu containing this plugin's 会话 or 文件 group is
 * stretched to the composer card's border box. On desktop, the primary
 * candidate label receives the remaining row width while trailing metadata
 * stays secondary and capped.
 *
 * Plain-text references: the plugin inserts ordinary `@label` text plus an
 * invisible metadata suffix. The atomic module paints the visible label with
 * source-specific colours; these rules keep the paint looking like normal
 * text (no chip background, no pill shape).
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

  [data-composer-card] [data-decoration='chip'] > span {
    display: block;
    color: var(--dsw-alias-label-primary);
    font-size: inherit;
    font-weight: 500;
    letter-spacing: normal;
    text-align: left;
    text-overflow: ellipsis;
  }

  [data-composer-card] [data-decoration='chip'][data-invalid] {
    opacity: 1;
  }

  [data-composer-card] [data-decoration='chip'][data-invalid] > span {
    color: var(--dsw-alias-state-error-primary);
  }
}

[data-composer-card] [data-input-backdrop] [data-at-ref] {
  color: #689efe;
  background: transparent;
  border-radius: 0;
  font-weight: inherit;
}

[data-composer-card] [data-input-backdrop] [data-at-ref][data-at-type='session'] {
  color: #9e8cfe;
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
