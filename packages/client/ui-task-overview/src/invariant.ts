/** Package-owned invariant companion for the desktop task overview. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

/** Cordis companion plugin name. */
export const name = 'client-ui-task-overview-invariant'
/** Required invariant registry. */
export const inject = ['invariants']

/**
 * No runtime invariant: this consumer derives rows from runtime snapshots
 * and owns only local navigation lifetime, not cross-plugin mutable state.
 */
const install: InvariantInstaller = () => {}

/**
 * Reserve this package's invariant registration.
 * @param ctx - context carrying the invariant service.
 * @returns registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@deepseek-ai/dsh-client-ui-task-overview', install))
