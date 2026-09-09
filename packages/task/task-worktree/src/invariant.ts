/** Package-owned invariant companion for the Task worktree Service Definition. @module @deepseek-ai/dsh-task-worktree/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-worktree'

/** Cordis companion plugin name. */
export const name = 'task-worktree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** The stateless Service Definition owns no mutable relationship to inspect. */
const install: InvariantInstaller = () => {}

/**
 * Register Task worktree invariant ownership.
 * @param ctx - Cordis context carrying the invariant registry.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
