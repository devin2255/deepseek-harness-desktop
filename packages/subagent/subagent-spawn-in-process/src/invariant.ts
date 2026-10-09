/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-subagent-spawn-in-process`.
 * @module @deepseek-ai/dsh-subagent-spawn-in-process/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { foldSubagentWorktree } from './worktree.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-subagent-spawn-in-process'

/** Cordis companion plugin name. */
export const name = 'subagent-spawn-in-process-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate writer assignments against their actual Session identity, parent, and cwd. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: (message: string) => never) => {
  const check = (session: Session, events: readonly SessionEvent[] = session.events): void => {
    const own = events.slice(session.header.seedLength ?? 0)
    let recorded: ReturnType<typeof foldSubagentWorktree>
    try {
      recorded = foldSubagentWorktree(own)
    } catch (error) {
      return fail(`invalid subagent worktree record: ${String(error)}`)
    }
    if (recorded === undefined) return
    if (session.id !== recorded.assignment.taskId || session.header.cwd !== recorded.assignment.path
      || session.header.parentSession !== recorded.parentTaskId || session.header.origin !== 'subagent') {
      fail('subagent worktree record does not match its Session identity, parent, or execution directory')
    }
  }
  for (const session of ctx.sessions.list()) check(session)
  ctx.on('session/created', (session) => { check(session) }, { global: true })
  // Session observers run after commit and contain exceptions; dispatch validation
  // must reject malformed execution identities before they enter the durable log.
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type === 'subagent/worktree-assigned') check(session, [...session.events, event])
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
