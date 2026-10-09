/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-subagent-control`.
 * @module @deepseek-ai/dsh-tool-subagent-control/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-subagent-control'

/** Cordis companion plugin name. */
export const name = 'tool-subagent-control-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: these tools own no independent lifecycle or Git stream; subagent delivery
 * belongs to the subagent service and reviewed Git mutations belong to the Task review Provider.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
