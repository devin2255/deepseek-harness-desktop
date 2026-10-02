/** Package-owned invariant companion for the Task review Service Definition. @module @deepseek-ai/dsh-task-review/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-review'

/** Cordis companion plugin name. */
export const name = 'task-review-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the stateless Service Definition owns no mutable relationship to inspect. */
const install: InvariantInstaller = () => {}

/**
 * Register Task review invariant ownership.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
