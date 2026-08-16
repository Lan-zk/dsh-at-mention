/**
 * dsh-at-mention, browser half: two `@` trigger sources over the input
 * trigger pipeline — workspace file search (live path references) and
 * cross-session references (readable chip, serialized to the canonical
 * dsh-session mention on submit, existence-probed before the send lands).
 * M3 placeholder: the sources register with the client milestone.
 * @module dsh-at-mention/src/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** Required services (informational dsh.client edges). */
export const inject = ['inputTriggers', 'sessions']

/** M3 placeholder: no registrations yet. */
export function apply(_ctx: ClientContext): void {}
