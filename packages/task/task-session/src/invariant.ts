/** Package-owned invariant companion for the Session-backed Task Provider. @module @deepseek-ai/dsh-task-session/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-task-session'

/** Cordis companion plugin name. */
export const name = 'task-session-invariant'
/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

/** Validate detached snapshot identities and root ownership relationships. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const validate = (): void => {
    const snapshot = ctx.tasks.snapshot()
    const roots = new Set(snapshot.tasks.map(task => task.taskId))
    if (roots.size !== snapshot.tasks.length) fail('task snapshot contains duplicate root ids')
    const descendants = new Set<string>()
    for (const task of snapshot.tasks) {
      for (const id of task.descendantSessionIds) {
        if (roots.has(id) || descendants.has(id)) fail(`Session "${id}" belongs to more than one Task row`)
        descendants.add(id)
      }
      for (const item of task.attention) {
        if (item.taskId !== task.taskId) fail(`attention item "${item.id}" names the wrong root Task`)
        if (item.ownerSessionId !== task.taskId && !task.descendantSessionIds.includes(item.ownerSessionId)) {
          fail(`attention item "${item.id}" names a Session outside its Task tree`)
        }
      }
    }
  }
  validate()
  ctx.effect(() => ctx.tasks.onChanged(validate), 'taskSessionInvariant.changed')
}, { inject: ['tasks'] })

/**
 * Register the Task Provider invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
