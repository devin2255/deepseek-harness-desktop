/** Coordinates Electron application events with retryable, attempt-owned Harness startup. */
import type { DesktopLog, DesktopLogEvent } from './desktop-log.ts'
import type { HarnessHandle, HarnessLaunchSpec, HarnessStartOptions } from './harness-supervisor.ts'
import { createStartupState, reduceStartup, type DesktopStartupState } from './startup-state.ts'
import type { StartupWindow, StartupWindowActions } from './startup-window.ts'
import type { DesktopWindow } from './window.ts'

const DESKTOP_APP_USER_MODEL_ID = 'ai.deepseek.harness.desktop'

/** The Electron quit event operation used to defer exit until asynchronous cleanup settles. */
export interface DesktopQuitEvent {
  /** Cancel the current quit attempt while owned cleanup runs. */
  preventDefault(): void
}

/** Electron application operations owned by the desktop lifecycle. */
export interface DesktopApp {
  /** Set the stable Windows application identity before native resources exist. */
  setAppUserModelId(id: string): void
  /** Enable Chromium's process sandbox before readiness. */
  enableSandbox(): void
  /** Acquire the application-wide single-instance lock. */
  requestSingleInstanceLock(): boolean
  /** Resolve when Electron permits window and utility-process creation. */
  whenReady(): Promise<void>
  /** Request application termination. */
  quit(): void
  /** Subscribe to asynchronous quit interception. */
  on(event: 'before-quit', listener: (event: DesktopQuitEvent) => void): this
  /** Subscribe to application lifecycle events without consumed payloads. */
  on(event: 'second-instance' | 'window-all-closed' | 'activate', listener: () => void): this
}

/** Replaceable operations at the Electron Main composition boundary. */
export interface DesktopMainDependencies {
  /** Electron application singleton. */
  readonly app: DesktopApp
  /** Explicit Harness child paths and environment. */
  readonly launchSpec: HarnessLaunchSpec
  /** Runtime operating-system identifier. */
  readonly platform: NodeJS.Platform
  /** Start one attempt-owned Harness child. */
  readonly startHarness: (launchSpec: HarnessLaunchSpec, options: HarnessStartOptions) => Promise<HarnessHandle>
  /** Create the authorized main window after Harness readiness. */
  readonly createWindow: (endpoint: URL, capability: string) => Promise<DesktopWindow>
  /** Create the immediate local recovery window. */
  readonly createStartupWindow: (actions: StartupWindowActions) => Promise<StartupWindow>
  /** Product-owned diagnostic log. */
  readonly desktopLog: Pick<DesktopLog, 'append' | 'currentPath'>
  /** Open one exact local path with the operating-system shell. */
  readonly openPath: (path: string) => Promise<string>
  /** Complete shutdown deadline, including startup that fails to honor cancellation. */
  readonly cleanupTimeoutMs: number
  /** Produce timestamps for persisted lifecycle events. */
  readonly now: () => string
  /** Report contained startup, shutdown, and callback failures. */
  readonly reportFailure: (phase: 'startup' | 'shutdown' | 'callback', error: unknown) => void
}

/** Observable lifecycle settlement used by focused tests and process owners. */
export interface DesktopMainHandle {
  /** Settle after the first attempt succeeds or exposes a retryable failure. */
  readonly startup: Promise<void>
  /** Settle after the first bounded shutdown request. */
  readonly shutdown: Promise<void>
}

interface StartupAttempt {
  readonly id: number
  readonly controller: AbortController
  handle?: HarnessHandle
  settled: Promise<void>
  stopTask?: Promise<void>
  superseded: boolean
}

/**
 * Start one desktop lifecycle with a local recovery window and serialized retry attempts.
 * @param dependencies - Electron, Harness, recovery window, log, and diagnostic operations.
 * @returns First-attempt and shutdown settlement promises.
 */
export function startDesktopMain(dependencies: DesktopMainDependencies): DesktopMainHandle {
  assertPositiveTimeout(dependencies.cleanupTimeoutMs)
  const { app } = dependencies
  const readinessController = new AbortController()
  let startupWindow: StartupWindow | undefined
  let activeWindow: DesktopWindow | undefined
  let disposeActiveWindowClosed: (() => void) | undefined
  let currentState: DesktopStartupState | undefined
  let currentAttempt: StartupAttempt | undefined
  let nextAttemptId = 1
  let retryTask: Promise<void> | undefined
  let windowCreation: Promise<DesktopWindow> | undefined
  let windowFocusRequest: Promise<void> | undefined
  let shutdownTask: Promise<void> | undefined
  let resolveShutdown!: () => void
  const shutdown = new Promise<void>((resolve) => { resolveShutdown = resolve })
  let quitLatched = false

  const report = (phase: 'startup' | 'shutdown' | 'callback', error: unknown): void => {
    try { dependencies.reportFailure(phase, error) } catch { /* Reporting must not escape Electron dispatch. */ }
  }
  const writeLog = (type: string, message: string): void => {
    try {
      const event: DesktopLogEvent = { timestamp: dependencies.now(), type, message }
      dependencies.desktopLog.append(event)
    } catch (error: unknown) { report('callback', error) }
  }
  const publish = (state: DesktopStartupState): void => {
    currentState = state
    startupWindow?.publish(state)
    writeLog('startup-state', `attempt=${state.attempt} phase=${state.phase} status=${state.status}`)
  }
  const publishEvent = (attempt: StartupAttempt, event: Parameters<typeof reduceStartup>[1]): void => {
    if (currentAttempt !== attempt || attempt.superseded || currentState === undefined) return
    publish(reduceStartup(currentState, event))
  }
  const attemptIsInactive = (attempt: StartupAttempt): boolean => (
    attempt.superseded || currentAttempt !== attempt || shutdownTask !== undefined
  )
  const stopAttempt = (attempt: StartupAttempt): Promise<void> => {
    attempt.stopTask ??= attempt.handle?.stop() ?? Promise.resolve()
    return attempt.stopTask
  }
  const runAttempt = (attempt: StartupAttempt): Promise<void> => (async () => {
    try {
      publishEvent(attempt, { type: 'runtime-loaded', attempt: attempt.id })
      publishEvent(attempt, { type: 'profile-validated', attempt: attempt.id })
      attempt.handle = await dependencies.startHarness(dependencies.launchSpec, { signal: attempt.controller.signal })
      if (attemptIsInactive(attempt)) {
        await stopAttempt(attempt)
        return
      }
      publishEvent(attempt, { type: 'service-started', attempt: attempt.id })
      const desktopWindow = await dependencies.createWindow(attempt.handle.endpoint, attempt.handle.capability)
      if (attemptIsInactive(attempt)) {
        await stopAttempt(attempt)
        return
      }
      publishEvent(attempt, { type: 'service-ready', attempt: attempt.id })
      const recovery = startupWindow
      if (recovery === undefined) throw new Error('Desktop startup window is unavailable for handoff')
      await recovery.handoffTo(desktopWindow)
      if (attemptIsInactive(attempt)) {
        await stopAttempt(attempt)
        return
      }
      startupWindow = undefined
      trackActiveWindow(desktopWindow)
      writeLog('startup-handoff', `attempt=${attempt.id}`)
    } catch (error: unknown) {
      try { await stopAttempt(attempt) } catch (stopError: unknown) {
        report(shutdownTask === undefined ? 'startup' : 'shutdown', stopError)
      }
      if (attemptIsInactive(attempt)) {
        if (!isAbortError(error) && shutdownTask !== undefined) report('shutdown', error)
        return
      }
      report('startup', error)
      if (currentState !== undefined) {
        const failed = reduceStartup(currentState, { type: 'failed', attempt: attempt.id, error })
        currentState = failed
        if (failed.status === 'failed') startupWindow?.showFailure(failed)
        writeLog('startup-state', `attempt=${attempt.id} phase=failed status=failed`)
      }
    }
  })()
  const beginAttempt = (): StartupAttempt => {
    const attempt: StartupAttempt = {
      id: nextAttemptId++, controller: new AbortController(), settled: Promise.resolve(), superseded: false,
    }
    currentAttempt = attempt
    currentState = createStartupState(attempt.id)
    publish(currentState)
    publishEvent(attempt, { type: 'electron-ready', attempt: attempt.id })
    attempt.settled = runAttempt(attempt)
    return attempt
  }
  const retry = (): Promise<void> => {
    retryTask ??= (async () => {
      const previous = currentAttempt
      if (previous === undefined || currentState === undefined || currentState.status === 'ready') return
      previous.superseded = true
      previous.controller.abort()
      await previous.settled
      if (shutdownTask !== undefined || quitLatched || startupWindow === undefined) return
      await beginAttempt().settled
    })().finally(() => { retryTask = undefined })
    return retryTask
  }
  const openLogs = async (): Promise<void> => {
    const errorMessage = await dependencies.openPath(dependencies.desktopLog.currentPath())
    if (errorMessage !== '') throw new Error('Electron could not open the desktop log')
  }
  const quitAfterCleanup = (): Promise<void> => {
    shutdownTask ??= (async () => {
      readinessController.abort()
      releaseActiveWindowClosed()
      const attempt = currentAttempt
      if (attempt !== undefined) { attempt.superseded = true; attempt.controller.abort() }
      try {
        await withTimeout((async () => {
          if (attempt !== undefined) { await attempt.settled; await stopAttempt(attempt) }
        })(), dependencies.cleanupTimeoutMs)
      } catch (error: unknown) { report('shutdown', error) } finally {
        quitLatched = true
        resolveShutdown()
        try { app.quit() } catch (error: unknown) { report('callback', error) }
      }
    })()
    return shutdownTask
  }
  const actions: StartupWindowActions = { retry, openLogs, exit: quitAfterCleanup }
  const focusLiveWindow = (): void => {
    if (shutdownTask !== undefined || quitLatched) return
    if (startupWindow !== undefined) { startupWindow.focus(); return }
    if (activeWindow !== undefined) { focusWindow(activeWindow); return }
    if (dependencies.platform !== 'darwin' || currentAttempt?.handle === undefined) return
    windowFocusRequest ??= createHarnessWindow(currentAttempt.handle)
      .then((window) => { if (shutdownTask === undefined && activeWindow === window) focusWindow(window) })
      .catch((error: unknown) => { report('callback', error) })
      .finally(() => { windowFocusRequest = undefined })
  }

  app.setAppUserModelId(DESKTOP_APP_USER_MODEL_ID)
  app.enableSandbox()
  const ownsInstance = app.requestSingleInstanceLock()
  app.on('before-quit', (event) => {
    try { if (quitLatched) return; event.preventDefault(); void quitAfterCleanup() } catch (error: unknown) {
      report('callback', error); void quitAfterCleanup()
    }
  })
  app.on('second-instance', () => { try { focusLiveWindow() } catch (error: unknown) { report('callback', error) } })
  app.on('window-all-closed', () => {
    try { if (dependencies.platform !== 'darwin') app.quit() } catch (error: unknown) { report('callback', error) }
  })
  app.on('activate', () => { try { if (dependencies.platform === 'darwin') focusLiveWindow() } catch (error: unknown) { report('callback', error) } })

  const startup = ownsInstance ? startOwnedInstance() : stopRejectedInstance()
  return { startup, shutdown }

  async function startOwnedInstance(): Promise<void> {
    try {
      await waitForReadiness(() => app.whenReady(), readinessController.signal)
      if (readinessController.signal.aborted) return
      startupWindow = await dependencies.createStartupWindow(actions)
      await beginAttempt().settled
    } catch (error: unknown) {
      if (readinessController.signal.aborted) return
      report('startup', error)
      await quitAfterCleanup()
    }
  }
  function stopRejectedInstance(): Promise<void> {
    readinessController.abort(); quitLatched = true; resolveShutdown()
    try { app.quit() } catch (error: unknown) { report('callback', error) }
    return Promise.resolve()
  }
  function createHarnessWindow(handle: HarnessHandle): Promise<DesktopWindow> {
    windowCreation ??= dependencies.createWindow(handle.endpoint, handle.capability)
      .then((window) => { if (shutdownTask === undefined) trackActiveWindow(window); return window })
      .finally(() => { windowCreation = undefined })
    return windowCreation
  }
  function trackActiveWindow(window: DesktopWindow): void {
    releaseActiveWindowClosed()
    activeWindow = window
    disposeActiveWindowClosed = window.onClosed(() => {
      if (activeWindow !== window) return
      activeWindow = undefined
      disposeActiveWindowClosed = undefined
    })
  }
  function releaseActiveWindowClosed(): void {
    const dispose = disposeActiveWindowClosed
    activeWindow = undefined
    disposeActiveWindowClosed = undefined
    if (dispose !== undefined) try { dispose() } catch (error: unknown) { report('callback', error) }
  }
}

function focusWindow(window: DesktopWindow): void { if (window.isMinimized()) window.restore(); window.focus() }
function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError' }
function assertPositiveTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Desktop cleanupTimeoutMs must be a positive integer')
}
function withTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Desktop cleanup exceeded ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    void task.then(
      () => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(asError(error, 'Desktop cleanup failed')) },
    )
  })
}
function waitForReadiness(whenReady: () => Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => { settle(resolve) }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      void whenReady().then(
        () => { settle(resolve) },
        (error: unknown) => { settle(() => { reject(asError(error, 'Electron readiness failed')) }) },
      )
    } catch (error: unknown) { settle(() => { reject(asError(error, 'Electron readiness failed')) }) }
    if (signal.aborted) onAbort()
  })
}
function asError(error: unknown, message: string): Error {
  return error instanceof Error ? error : new Error(message, { cause: error })
}
