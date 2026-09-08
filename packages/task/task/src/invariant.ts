/** Package-owned invariant companion for `@deepseek-ai/dsh-task`. @module @deepseek-ai/dsh-task/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task'

/** Cordis companion plugin name. */
export const name = 'task-invariant'

/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

/** Task vocabulary has no independently checkable relationship until a fold consumes its events. */
const install: InvariantInstaller = () => {}

/**
 * Register ownership of the durable task event vocabulary.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
