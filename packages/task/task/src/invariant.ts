/** Package-owned invariant companion for `@deepseek-ai/dsh-task`. @module @deepseek-ai/dsh-task/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyTaskEvent, emptyTaskFoldState } from './fold.ts'
import type { TaskFoldState } from './fold.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-task'

/** Cordis companion plugin name. */
export const name = 'task-invariant'

/** Service required before package ownership can be reserved. */
export const inject = ['invariants']

/** Apply one event through the strict task decoder and attribute failures. */
function applyChecked(state: TaskFoldState, event: SessionEvent, fail: InvariantFailure): TaskFoldState {
  try {
    return applyTaskEvent(state, event)
  } catch (error) {
    /* v8 ignore next -- the strict task decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    return fail(`session event ${event.seq} violates the durable task stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached Session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, TaskFoldState>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: TaskFoldState }>()

  const seed = (session: Session): TaskFoldState => {
    let state = emptyTaskFoldState()
    for (const event of session.events) state = applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): TaskFoldState => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    /* v8 ignore next -- the callback observes all Cordis dispatches by design */
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    staged.set(event, { session, state: applyChecked(stateFor(session), event, fail) })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching task-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the task-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
