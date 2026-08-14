/** Coordinates Electron application events with one supervised Harness and one desktop window. */

import type { HarnessHandle, HarnessStartOptions } from './harness-supervisor.ts'
import type { DesktopWindow } from './window.ts'

/** The Electron quit event operation used to defer exit until asynchronous cleanup settles. */
export interface DesktopQuitEvent {
  /** Cancel the current quit attempt while owned cleanup runs. */
  preventDefault(): void
}

/** Electron application operations owned by the desktop lifecycle. */
export interface DesktopApp {
  /** Enable Chromium's process sandbox before application readiness. */
  enableSandbox(): void
  /** Acquire the application-wide single-instance lock. */
  requestSingleInstanceLock(): boolean
  /** Resolve when Electron permits utility-process and window creation. */
  whenReady(): Promise<void>
  /** Request application termination. */
  quit(): void
  /** Subscribe to the asynchronous quit interception event. */
  on(event: 'before-quit', listener: (event: DesktopQuitEvent) => void): this
  /** Subscribe to application lifecycle events whose payload is not consumed. */
  on(event: 'second-instance' | 'window-all-closed' | 'activate', listener: () => void): this
}

/** Replaceable operations at the Electron Main composition boundary. */
export interface DesktopMainDependencies {
  /** Electron application singleton. */
  readonly app: DesktopApp
  /** Runtime operating-system identifier. */
  readonly platform: NodeJS.Platform
  /** Start the desktop Harness under caller-owned startup cancellation. */
  readonly startHarness: (options: HarnessStartOptions) => Promise<HarnessHandle>
  /** Create the authorized desktop window for a ready Harness. */
  readonly createWindow: (endpoint: URL, capability: string) => Promise<DesktopWindow>
  /** Count live native windows without retaining BrowserWindow authority here. */
  readonly windowCount: () => number
  /** Report contained startup, shutdown, and event-callback failures. */
  readonly reportFailure: (phase: 'startup' | 'shutdown' | 'callback', error: unknown) => void
}

/** Observable lifecycle settlement used by focused tests and process owners. */
export interface DesktopMainHandle {
  /** Resolves after startup succeeds, is rejected by the instance lock, or finishes failure cleanup. */
  readonly startup: Promise<void>
  /** Resolves after the first requested shutdown finishes; remains pending while the application runs. */
  readonly shutdown: Promise<void>
}

/**
 * Start one desktop application lifecycle and contain all Electron event callbacks.
 * @param dependencies - Electron, Harness, window, and diagnostic operations.
 * @returns Startup and shutdown settlement promises; neither rejects for contained lifecycle failures.
 */
export function startDesktopMain(dependencies: DesktopMainDependencies): DesktopMainHandle {
  const { app } = dependencies
  const startupController = new AbortController()
  let harness: HarnessHandle | undefined
  let activeWindow: DesktopWindow | undefined
  let windowCreation: Promise<DesktopWindow> | undefined
  let shutdownTask: Promise<void> | undefined
  let resolveShutdown!: () => void
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve
  })
  let quitLatched = false
  const startupWasAborted = (): boolean => startupController.signal.aborted

  const report = (phase: 'startup' | 'shutdown' | 'callback', error: unknown): void => {
    try {
      dependencies.reportFailure(phase, error)
    } catch {
      // Diagnostic reporting is best-effort; Electron callbacks must remain contained.
    }
  }

  const quitAfterCleanup = (waitForStartup = true): Promise<void> => {
    shutdownTask ??= (async () => {
      startupController.abort()
      try {
        if (waitForStartup) await startup
        if (harness !== undefined) await harness.stop()
      } catch (error: unknown) {
        report('shutdown', error)
      } finally {
        quitLatched = true
        resolveShutdown()
        try {
          app.quit()
        } catch (error: unknown) {
          report('callback', error)
        }
      }
    })()
    return shutdownTask
  }

  const createHarnessWindow = (): Promise<DesktopWindow> => {
    if (harness === undefined) return Promise.reject(new Error('Desktop Harness is not ready'))
    windowCreation ??= dependencies.createWindow(harness.endpoint, harness.capability).finally(() => {
      windowCreation = undefined
    })
    return windowCreation
  }

  app.enableSandbox()
  const ownsInstance = app.requestSingleInstanceLock()

  app.on('before-quit', (event) => {
    try {
      if (quitLatched) return
      event.preventDefault()
      void quitAfterCleanup()
    } catch (error: unknown) {
      report('callback', error)
      void quitAfterCleanup()
    }
  })

  app.on('second-instance', () => {
    try {
      if (activeWindow === undefined) return
      if (activeWindow.isMinimized()) activeWindow.restore()
      activeWindow.focus()
    } catch (error: unknown) {
      report('callback', error)
    }
  })

  app.on('window-all-closed', () => {
    try {
      if (dependencies.platform !== 'darwin') app.quit()
    } catch (error: unknown) {
      report('callback', error)
    }
  })

  app.on('activate', () => {
    try {
      if (dependencies.platform !== 'darwin' || harness === undefined || dependencies.windowCount() !== 0) return
      void createHarnessWindow().then((window) => {
        activeWindow = window
      }, (error: unknown) => {
        report('callback', error)
      })
    } catch (error: unknown) {
      report('callback', error)
    }
  })

  const startup = ownsInstance
    ? startOwnedInstance()
    : stopRejectedInstance()

  return { startup, shutdown }

  async function startOwnedInstance(): Promise<void> {
    try {
      await app.whenReady()
      if (startupWasAborted()) return
      harness = await dependencies.startHarness({ signal: startupController.signal })
      if (startupWasAborted()) return
      activeWindow = await createHarnessWindow()
    } catch (error: unknown) {
      if (startupWasAborted()) return
      report('startup', error)
      await quitAfterCleanup(false)
    }
  }

  function stopRejectedInstance(): Promise<void> {
    startupController.abort()
    quitLatched = true
    resolveShutdown()
    try {
      app.quit()
    } catch (error: unknown) {
      report('callback', error)
    }
    return Promise.resolve()
  }
}
