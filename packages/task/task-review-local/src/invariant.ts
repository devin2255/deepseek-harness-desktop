/** Package-owned invariant companion for the local Task review Provider. @module @deepseek-ai/dsh-task-review-local/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-review-local'

/** Cordis companion plugin name. */
export const name = 'task-review-local-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: Git is authoritative and every review is request-scoped. */
const install: InvariantInstaller = () => {}

/**
 * Register local Task review invariant ownership.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
