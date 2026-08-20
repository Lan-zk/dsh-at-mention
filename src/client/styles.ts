/**
 * Client-side presentation overrides for the at-mention trigger experience.
 * The candidate popup and the composer chips are rendered by upstream
 * packages, so this plugin contributes a small plugin-owned stylesheet
 * instead of forking their components. Selectors use the stable
 * `data-composer-card` / `data-decoration` attributes published by the
 * composer DOM; no CSS-module hashes are referenced.
 *
 * Reference chips are rendered by the host in a fixed-width placeholder cell
 * (the chip's advance must equal the textarea's U+FFFC advance). This plugin
 * deliberately does not restyle every `[data-decoration='chip']`: the rules
 * below carry a `[data-source='文件']` / `[data-source='会话']` guard so only
 * this plugin's references are presented as "invisible" chips (no pill
 * background, no rounded capsule), while other plugins' chips keep the host
 * look. The guard relies on the host rendering `data-source` from the
 * occurrence owner (upstream `ui-conversation` `ChipRender.source`).
 *
 * Colours use theme-aware tokens that meet WCAG AA on both themes; the two
 * reference kinds stay distinguishable (file blue, session violet).
 * @module dsh-at-mention/src/client/styles
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

/** Plugin-owned style tag id (`<style data-plugin-css>` value). */
export const CLIENT_STYLE_ID = 'dsh-at-mention/client-styles'

/**
 * Presentation overrides aligned with the harness DESIGN.md.
 *
 * The candidate menu is owned by upstream ui-input-trigger and already
 * consumes the design-system tokens, so this plugin only adjusts its own
 * reference chips. At-mention chips are intentionally "invisible" chips: no
 * pill background or radius, normal font metrics, one DeepSeek-blue signal
 * color from the semantic alias ladder. No theme branches and no literal
 * colors live here; the alias token adapts to light/dark automatically.
 */
export const CLIENT_STYLES = `
[data-composer-card] [data-input-backdrop] [data-decoration='chip'][data-source='文件'],
[data-composer-card] [data-input-backdrop] [data-decoration='chip'][data-source='会话'] {
  position: relative;
  background: transparent;
  border-radius: 0;
  box-shadow: none;
}

[data-composer-card] [data-input-backdrop] [data-decoration='chip'][data-source='文件'] > span,
[data-composer-card] [data-input-backdrop] [data-decoration='chip'][data-source='会话'] > span {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  overflow: hidden;
  white-space: nowrap;
  transform: none;
  font-size: inherit;
  font-weight: inherit;
  letter-spacing: normal;
  text-align: left;
  color: var(--dsw-alias-state-business-primary);
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
    // Re-entrant/HMR-safe ownership: a previous evaluation may still own a
    // style tag. Replace it with a fresh tag owned by this effect so the old
    // fiber's disposer can never remove the new fiber's stylesheet.
    const existing = findStyle(CLIENT_STYLE_ID)
    existing?.remove()
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
