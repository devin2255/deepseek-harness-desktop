/** Package-owned invariant companion for the Task Review workspace. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'client-ui-task-review-invariant'
/** Required invariant registry. */
export const inject = ['invariants']

/** No runtime invariant: typed registration and the Task runtime own every mutable relationship. */
const install: InvariantInstaller = () => {}

/** Register package ownership. @param ctx - invariant context. @returns registration disposer. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-ui-task-review', install))
