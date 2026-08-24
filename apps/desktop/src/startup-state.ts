/** Models desktop startup and retry attempts without retaining raw failure diagnostics. */

/** Startup phases that actively perform work. */
export type DesktopStartupWorking =
  | { readonly attempt: number; readonly phase: 'waiting-electron'; readonly status: 'working' }
  | { readonly attempt: number; readonly phase: 'loading-runtime'; readonly status: 'working' }
  | { readonly attempt: number; readonly phase: 'validating-profile'; readonly status: 'working' }
  | { readonly attempt: number; readonly phase: 'starting-service'; readonly status: 'working' }
  | { readonly attempt: number; readonly phase: 'probing-service'; readonly status: 'working' }

/** Stable failure details safe to expose to the desktop renderer. */
export interface DesktopStartupError {
  /** Machine-readable failure category independent of diagnostic text. */
  readonly code:
    | 'electron-unavailable'
    | 'runtime-unavailable'
    | 'profile-invalid'
    | 'service-start-failed'
    | 'service-unreachable'
    | 'unexpected-startup-failure'
  /** Short recovery instruction that contains no internal diagnostic details. */
  readonly action: string
}

/** A failed attempt with renderer-safe recovery details. */
export interface DesktopStartupFailure {
  readonly attempt: number
  readonly phase: 'failed'
  readonly status: 'failed'
  readonly error: DesktopStartupError
}

/** A completed startup attempt. */
export interface DesktopStartupReady {
  readonly attempt: number
  readonly phase: 'ready'
  readonly status: 'ready'
}

/** Every renderer-visible desktop startup state. */
export type DesktopStartupState = DesktopStartupWorking | DesktopStartupFailure | DesktopStartupReady

/** Lifecycle inputs accepted by the startup reducer. */
export type DesktopStartupEvent =
  | { readonly type: 'electron-ready'; readonly attempt: number }
  | { readonly type: 'runtime-loaded'; readonly attempt: number }
  | { readonly type: 'profile-validated'; readonly attempt: number }
  | { readonly type: 'service-started'; readonly attempt: number }
  | { readonly type: 'service-ready'; readonly attempt: number }
  | { readonly type: 'failed'; readonly attempt: number; readonly error: unknown }
  | { readonly type: 'retry'; readonly attempt: number }

/**
 * Create the state shown before Electron reports readiness.
 * @param attempt - Positive startup-attempt identifier.
 * @returns Initial state for the requested attempt.
 */
export function createStartupState(attempt: number): DesktopStartupWorking {
  assertAttempt(attempt)
  return { attempt, phase: 'waiting-electron', status: 'working' }
}

/**
 * Apply one lifecycle event while excluding updates from superseded attempts.
 * @param state - Current startup state.
 * @param event - Lifecycle event tagged with its originating attempt.
 * @returns The next startup state, or the same state for stale or out-of-order events.
 */
export function reduceStartup(state: DesktopStartupState, event: DesktopStartupEvent): DesktopStartupState {
  if (event.type === 'retry') {
    if (state.phase !== 'failed' || event.attempt <= state.attempt) return state
    assertAttempt(event.attempt)
    return { attempt: event.attempt, phase: 'loading-runtime', status: 'working' }
  }
  if (event.attempt !== state.attempt) return state

  switch (event.type) {
    case 'electron-ready':
      return state.phase === 'waiting-electron'
        ? { attempt: state.attempt, phase: 'loading-runtime', status: 'working' }
        : state
    case 'runtime-loaded':
      return state.phase === 'loading-runtime'
        ? { attempt: state.attempt, phase: 'validating-profile', status: 'working' }
        : state
    case 'profile-validated':
      return state.phase === 'validating-profile'
        ? { attempt: state.attempt, phase: 'starting-service', status: 'working' }
        : state
    case 'service-started':
      return state.phase === 'starting-service'
        ? { attempt: state.attempt, phase: 'probing-service', status: 'working' }
        : state
    case 'service-ready':
      return state.phase === 'probing-service'
        ? { attempt: state.attempt, phase: 'ready', status: 'ready' }
        : state
    case 'failed':
      return state.phase === 'failed'
        ? state
        : {
          attempt: state.attempt,
          phase: 'failed',
          status: 'failed',
          error: projectStartupError(state.phase, event.error),
        }
    default:
      return assertNever(event)
  }
}

/** Map a failing phase to fixed renderer text, deliberately discarding the raw error. */
function projectStartupError(
  phase: Exclude<DesktopStartupState['phase'], 'failed'>,
  rawError: unknown,
): DesktopStartupError {
  void rawError
  switch (phase) {
    case 'waiting-electron':
      return { code: 'electron-unavailable', action: 'Exit the application and start it again.' }
    case 'loading-runtime':
      return { code: 'runtime-unavailable', action: 'Reinstall the application, then retry startup.' }
    case 'validating-profile':
      return { code: 'profile-invalid', action: 'Retry startup. If the problem continues, open the desktop log.' }
    case 'starting-service':
      return { code: 'service-start-failed', action: 'Retry startup. If the problem continues, open the desktop log.' }
    case 'probing-service':
      return { code: 'service-unreachable', action: 'Retry startup. If the problem continues, open the desktop log.' }
    case 'ready':
      return { code: 'unexpected-startup-failure', action: 'Exit the application and start it again.' }
    default:
      return assertNever(phase)
  }
}

/** Reject invalid attempt identifiers at the public construction boundary. */
function assertAttempt(attempt: number): void {
  if (!Number.isSafeInteger(attempt) || attempt <= 0) throw new Error('Startup attempt must be a positive safe integer')
}

/** Prove exhaustive handling for closed discriminated unions. */
function assertNever(value: never): never {
  throw new Error(`Unhandled desktop startup value: ${String(value)}`)
}
