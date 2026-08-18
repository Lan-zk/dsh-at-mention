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
 * Theme-aware presentation overrides.
 *
 * Popup: only a trigger menu containing this plugin's 会话 or 文件 group is
 * stretched to the composer card's border box. On desktop, the primary
 * candidate label receives the remaining row width while trailing metadata
 * stays secondary and capped.
 *
 * Invisible reference chips: at-mention references look like ordinary text —
 * transparent background, no border radius, normal font size/weight — only
 * distinguished by the file/session colour. The host's placeholder cell keeps
 * the caret/selection stream aligned; long labels are still clipped inside
 * the fixed cell (an upstream limitation of the chip cell model).
 */
export const CLIENT_STYLES = `
:root, body:not([data-ds-dark-theme]) {
  --dsh-at-mention-file-color: var(--dsw-static-deepseek-600);
  --dsh-at-mention-session-color: #6d56e0;
}

body[data-ds-dark-theme] {
  --dsh-at-mention-file-color: var(--dsw-static-deepseek-400);
  --dsh-at-mention-session-color: #a78bfa;
}

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
  left: var(--dsh-at-mention-chip-label-left, 0);
  top: var(--dsh-at-mention-chip-label-top, 0);
  width: var(--dsh-at-mention-chip-label-width, 100%);
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
  color: var(--dsh-at-mention-file-color);
}

[data-composer-card] [data-input-backdrop] [data-decoration='chip'][data-source='会话'] > span {
  color: var(--dsh-at-mention-session-color);
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
