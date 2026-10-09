/** Package-owned invariant companion for the read-only Studio contribution. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-harness-studio'

/** Cordis companion plugin name. */
export const name = 'client-ui-harness-studio-invariant'
/** Service required before registering package ownership. */
export const inject = ['invariants']

/** No runtime invariant: Studio contributes only a read-only root slot. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
