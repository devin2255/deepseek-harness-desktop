/** Owns scheduled Windows release checks without letting updater events bypass desktop shutdown. */

/** State projected into the native tray. */
export type DesktopUpdateState =
  | { readonly kind: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'error' }
  | { readonly kind: 'ready' | 'installing'; readonly version: string }

/** Narrow adapter over electron-updater for deterministic lifecycle tests. */
export interface DesktopUpdateBackend {
  checkForUpdates(): Promise<{ readonly isUpdateAvailable: boolean; readonly updateInfo: { readonly version: string } } | null>
  downloadUpdate(): Promise<readonly string[]>
  quitAndInstall(): void
  onDownloaded(listener: (version: string) => void): () => void
  onError(listener: (error: Error) => void): () => void
}

/** Main-process update controls used by native presentation. */
export interface DesktopUpdates {
  currentState(): DesktopUpdateState
  subscribe(listener: (state: DesktopUpdateState) => void): () => void
  start(): void
  check(): Promise<void>
  install(): Promise<void>
  dispose(): void
}

/** Construction settings for checked, downloaded, and explicitly installed updates. */
export interface DesktopUpdateOptions {
  readonly backend: DesktopUpdateBackend
  readonly initialDelayMs: number
  readonly intervalMs: number
  readonly requestInstall: (launchInstaller: () => void) => Promise<boolean>
  readonly reportFailure: (error: unknown) => void
}

/**
 * Create a signed-package updater with one serialized check and explicit installation consent.
 * @param options - Updater adapter, schedule, lifecycle handoff, and failure reporting.
 * @returns Update operations and a disposer for timers and event listeners.
 */
export function createDesktopUpdates(options: DesktopUpdateOptions): DesktopUpdates {
  if (!Number.isSafeInteger(options.initialDelayMs) || options.initialDelayMs < 0) throw new Error('Desktop update initial delay must be nonnegative')
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) throw new Error('Desktop update interval must be positive')
  const listeners = new Set<(state: DesktopUpdateState) => void>()
  let state: DesktopUpdateState = { kind: 'idle' }
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let disposed = false
  let checkTask: Promise<void> | undefined
  let installTask: Promise<void> | undefined
  let expectedVersion: string | undefined
  const isDisposed = (): boolean => disposed
  const currentState = (): DesktopUpdateState => state

  const report = (error: unknown): void => {
    try { options.reportFailure(error) } catch { /* A diagnostic failure cannot escape an updater callback. */ }
  }
  const publish = (next: DesktopUpdateState): void => {
    if (disposed) return
    state = next
    for (const listener of listeners) {
      try { listener(next) } catch (error: unknown) { report(error) }
    }
  }
  const fail = (error: unknown): void => {
    if (disposed || state.kind === 'error') return
    publish({ kind: 'error' })
    report(error)
  }
  const schedule = (delayMs: number): void => {
    if (disposed || !started || state.kind === 'ready' || state.kind === 'installing') return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void check()
    }, delayMs)
    timer.unref()
  }
  const removeDownloaded = options.backend.onDownloaded((version) => {
    if (disposed || state.kind !== 'downloading') return
    if (version !== expectedVersion) {
      fail(new Error('Desktop update download version differs from the checked release'))
      return
    }
    publish({ kind: 'ready', version })
  })
  const removeError = options.backend.onError(fail)

  const check = (): Promise<void> => {
    if (disposed || state.kind === 'ready' || state.kind === 'installing') return Promise.resolve()
    if (checkTask !== undefined) return checkTask
    checkTask = (async () => {
      publish({ kind: 'checking' })
      try {
        const result = await options.backend.checkForUpdates()
        if (isDisposed() || currentState().kind === 'error') return
        if (result === null) throw new Error('Desktop update checks are unavailable for this package')
        if (!result.isUpdateAvailable) {
          expectedVersion = undefined
          publish({ kind: 'up-to-date' })
          return
        }
        const version = result.updateInfo.version
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
          throw new Error('Desktop update release version is invalid')
        }
        expectedVersion = version
        publish({ kind: 'downloading' })
        await options.backend.downloadUpdate()
        if (!isDisposed() && currentState().kind === 'downloading') throw new Error('Desktop updater finished without a verified download event')
      } catch (error: unknown) {
        fail(error)
      } finally {
        checkTask = undefined
        schedule(options.intervalMs)
      }
    })()
    return checkTask
  }

  return {
    currentState,
    subscribe(listener) {
      if (disposed) return () => {}
      listeners.add(listener)
      try { listener(state) } catch (error: unknown) { report(error) }
      return () => { listeners.delete(listener) }
    },
    start() {
      if (started || disposed) return
      started = true
      schedule(options.initialDelayMs)
    },
    check,
    install() {
      if (disposed || state.kind !== 'ready') return Promise.resolve()
      if (installTask !== undefined) return installTask
      const version = state.version
      installTask = (async () => {
        publish({ kind: 'installing', version })
        try {
          const accepted = await options.requestInstall(() => { options.backend.quitAndInstall() })
          if (!accepted) publish({ kind: 'ready', version })
        } catch (error: unknown) {
          fail(error)
        } finally {
          installTask = undefined
        }
      })()
      return installTask
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      removeDownloaded()
      removeError()
      listeners.clear()
    },
  }
}
