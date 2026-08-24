import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  startDesktopMain,
  type DesktopApp,
  type DesktopMainDependencies,
  type DesktopQuitEvent,
} from '../src/main-lifecycle.ts'
import { HarnessShutdownTimeoutError, type HarnessHandle, type HarnessLaunchSpec } from '../src/harness-supervisor.ts'
import type { StartupWindow, StartupWindowActions } from '../src/startup-window.ts'
import type { DesktopWindow } from '../src/window.ts'

function deferred<T>(): {
  readonly promise: Promise<T>
  readonly resolve: (value: T | PromiseLike<T>) => void
  readonly reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

class FakeApp extends EventEmitter implements DesktopApp {
  readonly calls: string[] = []
  readonly setAppUserModelId = vi.fn(() => {
    this.calls.push('setAppUserModelId')
  })
  readonly enableSandbox = vi.fn(() => {
    this.calls.push('enableSandbox')
  })
  readonly requestSingleInstanceLock = vi.fn(() => {
    this.calls.push('requestSingleInstanceLock')
    return true
  })
  readonly whenReady = vi.fn(async () => {
    this.calls.push('whenReady')
  })
  readonly quit = vi.fn(() => {
    this.calls.push('quit')
  })

  emitBeforeQuit(): { readonly preventDefault: Mock<DesktopQuitEvent['preventDefault']> } {
    const event = { preventDefault: vi.fn() }
    this.emit('before-quit', event)
    return event
  }
}

function fixture(overrides: Partial<DesktopMainDependencies> = {}): {
  readonly app: FakeApp
  readonly dependencies: DesktopMainDependencies
  readonly harness: HarnessHandle
  readonly focus: Mock<DesktopWindow['focus']>
  readonly isMinimized: Mock<DesktopWindow['isMinimized']>
  readonly restore: Mock<DesktopWindow['restore']>
  readonly closeWindow: () => void
  readonly disposeClosed: Mock<() => void>
  readonly window: DesktopWindow
  readonly createWindow: DesktopMainDependencies['createWindow']
  readonly createStartupWindow: DesktopMainDependencies['createStartupWindow']
  readonly startupActions: () => StartupWindowActions
  readonly startupFocus: Mock<StartupWindow['focus']>
  readonly publish: Mock<StartupWindow['publish']>
  readonly showFailure: Mock<StartupWindow['showFailure']>
  readonly handoffTo: Mock<StartupWindow['handoffTo']>
  readonly openPath: DesktopMainDependencies['openPath']
  readonly desktopLog: DesktopMainDependencies['desktopLog']
  readonly reportFailure: DesktopMainDependencies['reportFailure']
  readonly startHarness: Mock<DesktopMainDependencies['startHarness']>
  readonly stop: HarnessHandle['stop']
} {
  const app = new FakeApp()
  const stop = vi.fn(async () => {})
  const harness: HarnessHandle = {
    endpoint: new URL('http://127.0.0.1:4312'),
    capability: 'private-capability',
    stop,
  }
  const isMinimized = vi.fn(() => false)
  const restore = vi.fn()
  const focus = vi.fn()
  let closedListener: (() => void) | undefined
  const disposeClosed = vi.fn(() => {
    closedListener = undefined
  })
  const window: DesktopWindow = {
    focus,
    isMinimized,
    onClosed(listener) {
      closedListener = listener
      return disposeClosed
    },
    restore,
  }
  const startHarness = vi.fn(async () => harness)
  const createWindow = vi.fn(async () => window)
  const startupFocus = vi.fn()
  const publish = vi.fn()
  const showFailure = vi.fn()
  const handoffTo = vi.fn(async () => {})
  const startupWindow: StartupWindow = {
    closed: new Promise(() => {}),
    focus: startupFocus,
    publish,
    showFailure,
    handoffTo,
  }
  let capturedStartupActions: StartupWindowActions | undefined
  const createStartupWindow = vi.fn(async (actions: StartupWindowActions) => {
    capturedStartupActions = actions
    return startupWindow
  })
  const openPath = vi.fn(async () => '')
  const desktopLog = {
    append: vi.fn(),
    currentPath: vi.fn(() => 'C:\\Users\\tester\\AppData\\Roaming\\DeepSeek Harness\\logs\\desktop.log'),
  }
  const reportFailure = vi.fn()
  const launchSpec: HarnessLaunchSpec = {
    cliEntry: 'C:\\Program Files\\DeepSeek Harness\\resources\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    cwd: 'C:\\Users\\tester',
    environment: { DSH_HOME: 'C:\\Users\\tester\\AppData\\Roaming\\DeepSeek Harness\\Harness' },
  }
  const dependencies: DesktopMainDependencies = {
    app,
    launchSpec,
    platform: 'win32',
    startHarness,
    createWindow,
    createStartupWindow,
    desktopLog,
    openPath,
    cleanupTimeoutMs: 100,
    now: () => '2026-08-24T00:00:00.000Z',
    reportFailure,
    ...overrides,
  }
  return {
    app,
    dependencies,
    harness,
    closeWindow() {
      const listener = closedListener
      closedListener = undefined
      listener?.()
    },
    disposeClosed,
    focus,
    isMinimized,
    restore,
    window,
    createWindow: dependencies.createWindow,
    createStartupWindow: dependencies.createStartupWindow,
    startupActions() {
      if (capturedStartupActions === undefined) throw new Error('Startup actions are not ready')
      return capturedStartupActions
    },
    startupFocus,
    publish,
    showFailure,
    handoffTo,
    openPath: dependencies.openPath,
    desktopLog: dependencies.desktopLog,
    reportFailure,
    startHarness: vi.mocked(dependencies.startHarness),
    stop,
  }
}

async function flushLifecycle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('startDesktopMain', () => {
  it('creates the startup window after Electron readiness and before Harness startup', async () => {
    const ready = deferred<undefined>()
    const events: string[] = []
    const { app, dependencies, harness, createWindow, startHarness } = fixture({
      createStartupWindow: vi.fn(async () => {
        events.push('startup-window')
        return fixture().createStartupWindow({
          retry: async () => {},
          openLogs: async () => {},
          exit: async () => {},
        })
      }),
      startHarness: vi.fn(async () => {
        events.push('harness')
        return harness
      }),
      createWindow: vi.fn(async () => {
        events.push('window')
        return fixture().window
      }),
    })
    app.whenReady.mockImplementation(async () => {
      events.push('ready-wait')
      await ready.promise
      events.push('ready')
    })

    const desktop = startDesktopMain(dependencies)

    expect(app.calls.slice(0, 3)).toEqual(['setAppUserModelId', 'enableSandbox', 'requestSingleInstanceLock'])
    expect(app.setAppUserModelId).toHaveBeenCalledWith('ai.deepseek.harness.desktop')
    expect(events).toEqual(['ready-wait'])
    expect(startHarness).not.toHaveBeenCalled()

    ready.resolve(undefined)
    await desktop.startup

    expect(events).toEqual(['ready-wait', 'ready', 'startup-window', 'harness', 'window'])
    expect(startHarness).toHaveBeenCalledTimes(1)
    expect(startHarness.mock.calls[0]?.[0]).toBe(dependencies.launchSpec)
    expect(startHarness.mock.calls[0]?.[1].signal).toBeInstanceOf(AbortSignal)
    expect(createWindow).toHaveBeenCalledWith(harness.endpoint, harness.capability)
  })

  it('keeps the startup window open on failure and retries only after the old attempt settles', async () => {
    const first = deferred<HarnessHandle>()
    const second = fixture().harness
    const startHarness = vi.fn<DesktopMainDependencies['startHarness']>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(second)
    const { dependencies, startupActions, showFailure, handoffTo } = fixture({ startHarness })
    const desktop = startDesktopMain(dependencies)
    await flushLifecycle()

    const firstSignal = startHarness.mock.calls[0]?.[1].signal
    if (firstSignal === undefined) throw new Error('First startup signal was not captured')
    const retryOne = startupActions().retry()
    const retryTwo = startupActions().retry()
    expect(firstSignal.aborted).toBe(true)
    expect(startHarness).toHaveBeenCalledTimes(1)

    first.reject(new Error('first attempt failed'))
    await Promise.all([retryOne, retryTwo])
    await desktop.startup

    expect(showFailure).not.toHaveBeenCalled()
    expect(startHarness).toHaveBeenCalledTimes(2)
    expect(startHarness.mock.calls[1]?.[1].signal).not.toBe(firstSignal)
    expect(handoffTo).toHaveBeenCalledTimes(1)
  })

  it('publishes a current failure without quitting and opens only the current desktop log', async () => {
    const failure = new Error('supervised startup failed')
    const { app, dependencies, desktopLog, openPath, showFailure, startupActions } = fixture({
      startHarness: vi.fn(async () => { throw failure }),
    })
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    expect(showFailure).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, status: 'failed' }))
    expect(app.quit).not.toHaveBeenCalled()
    await startupActions().openLogs()
    expect(openPath).toHaveBeenCalledWith(desktopLog.currentPath())
  })

  it('prevents stale attempts from publishing after a retry owns the startup window', async () => {
    const first = deferred<HarnessHandle>()
    const second = fixture().harness
    const startHarness = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(second)
    const { dependencies, publish, showFailure, startupActions } = fixture({ startHarness })
    const desktop = startDesktopMain(dependencies)
    await flushLifecycle()
    const retry = startupActions().retry()
    first.reject(new Error('stale failure'))
    await retry
    await desktop.startup

    expect(showFailure).not.toHaveBeenCalled()
    expect(publish.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ attempt: 2, status: 'ready' }))
  })

  it('focuses the live startup window for a second instance before successful handoff', async () => {
    const pending = deferred<HarnessHandle>()
    const { app, dependencies, startupFocus } = fixture({ startHarness: vi.fn(() => pending.promise) })
    startDesktopMain(dependencies)
    await flushLifecycle()

    app.emit('second-instance')

    expect(startupFocus).toHaveBeenCalledTimes(1)
  })

  it('keeps the startup window current until handoff settles atomically', async () => {
    const handoff = deferred<undefined>()
    const setup = fixture()
    setup.handoffTo.mockReturnValue(handoff.promise)
    const desktop = startDesktopMain(setup.dependencies)
    await flushLifecycle()

    setup.app.emit('second-instance')
    expect(setup.startupFocus).toHaveBeenCalledTimes(1)
    expect(setup.focus).not.toHaveBeenCalled()

    handoff.resolve(undefined)
    await desktop.startup
    setup.app.emit('second-instance')
    expect(setup.focus).toHaveBeenCalledTimes(1)
  })

  it('stops a late stale attempt child before launching the one replacement', async () => {
    const first = deferred<HarnessHandle>()
    const stale = fixture()
    const current = fixture()
    const startHarness = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(current.harness)
    const setup = fixture({ startHarness })
    startDesktopMain(setup.dependencies)
    await flushLifecycle()

    const retry = setup.startupActions().retry()
    first.resolve(stale.harness)
    await retry

    expect(stale.stop).toHaveBeenCalledTimes(1)
    expect(startHarness).toHaveBeenCalledTimes(2)
  })

  it('bounds Exit when an attempt ignores cancellation and still exits once', async () => {
    vi.useFakeTimers()
    try {
      const setup = fixture({
        cleanupTimeoutMs: 20,
        startHarness: vi.fn<DesktopMainDependencies['startHarness']>(() => new Promise<HarnessHandle>(() => {})),
      })
      const desktop = startDesktopMain(setup.dependencies)
      await vi.advanceTimersByTimeAsync(0)

      const exiting = setup.startupActions().exit()
      await vi.advanceTimersByTimeAsync(20)
      await exiting
      await desktop.shutdown

      expect(setup.app.quit).toHaveBeenCalledTimes(1)
      expect(setup.reportFailure).toHaveBeenCalledWith('shutdown', expect.objectContaining({
        message: 'Desktop cleanup exceeded 20ms',
      }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('quits a rejected second instance without waiting or starting resources', async () => {
    const { app, dependencies, startHarness, createWindow } = fixture()
    app.requestSingleInstanceLock.mockReturnValue(false)

    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    expect(app.enableSandbox).toHaveBeenCalledTimes(1)
    expect(app.whenReady).not.toHaveBeenCalled()
    expect(startHarness).not.toHaveBeenCalled()
    expect(createWindow).not.toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('restores a minimized window and focuses it for a second-instance event', async () => {
    const { app, dependencies, createWindow, focus, isMinimized, restore, startHarness } = fixture()
    isMinimized.mockReturnValue(true)
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    app.emit('second-instance')

    expect(restore).toHaveBeenCalledTimes(1)
    expect(focus).toHaveBeenCalledTimes(1)
    expect(startHarness).toHaveBeenCalledTimes(1)
    expect(createWindow).toHaveBeenCalledTimes(1)
  })

  it('aborts pending startup and completes one asynchronous stop before latched quit', async () => {
    const started = deferred<HarnessHandle>()
    const { app, dependencies, createWindow, harness, stop } = fixture({ startHarness: vi.fn(() => started.promise) })
    const desktop = startDesktopMain(dependencies)
    await flushLifecycle()
    const signal = vi.mocked(dependencies.startHarness).mock.calls[0]?.[1].signal

    const first = app.emitBeforeQuit()
    const second = app.emitBeforeQuit()
    expect(first.preventDefault).toHaveBeenCalledTimes(1)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)

    started.resolve(harness)
    await desktop.shutdown

    expect(stop).toHaveBeenCalledTimes(1)
    expect(createWindow).not.toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalledTimes(1)

    const latched = app.emitBeforeQuit()
    expect(latched.preventDefault).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('settles latched shutdown while Electron readiness remains unresolved', async () => {
    const ready = deferred<undefined>()
    const { app, dependencies, startHarness } = fixture()
    app.whenReady.mockReturnValue(ready.promise)
    const desktop = startDesktopMain(dependencies)
    await flushLifecycle()

    app.emitBeforeQuit()

    await expect(Promise.race([
      desktop.shutdown.then(() => 'settled'),
      flushLifecycle().then(() => 'pending'),
    ])).resolves.toBe('settled')
    await desktop.startup
    expect(startHarness).not.toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('reports a non-Error Electron readiness rejection as an Error', async () => {
    const { app, dependencies, reportFailure, startHarness } = fixture()
    app.whenReady.mockRejectedValue('Electron readiness rejected')
    const desktop = startDesktopMain(dependencies)

    await desktop.startup

    expect(reportFailure).toHaveBeenCalledWith('startup', expect.objectContaining({
      cause: 'Electron readiness rejected',
      message: 'Electron readiness failed',
    }))
    expect(startHarness).not.toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('reports a child-that-never-exits abort rejection once and still latches quit', async () => {
    const failure = new HarnessShutdownTimeoutError(10)
    const { app, dependencies, reportFailure } = fixture({
      startHarness: vi.fn<DesktopMainDependencies['startHarness']>((_launchSpec, { signal }) => new Promise<HarnessHandle>((_resolve, reject) => {
        signal?.addEventListener('abort', () => { reject(failure) }, { once: true })
      })),
    })
    const desktop = startDesktopMain(dependencies)
    await flushLifecycle()

    app.emitBeforeQuit()
    await Promise.all([desktop.startup, desktop.shutdown])

    expect(reportFailure).toHaveBeenCalledTimes(1)
    expect(reportFailure).toHaveBeenCalledWith('shutdown', failure)
    expect(reportFailure).not.toHaveBeenCalledWith('startup', failure)
    expect(app.quit).toHaveBeenCalledTimes(1)
    expect(app.emitBeforeQuit().preventDefault).not.toHaveBeenCalled()
  })

  it('reports a stop failure and still reaches the latched quit without rejecting', async () => {
    const failure = new Error('bounded stop failure')
    const { app, dependencies, reportFailure, stop } = fixture()
    vi.mocked(stop).mockRejectedValue(failure)
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    app.emitBeforeQuit()
    await desktop.shutdown

    expect(reportFailure).toHaveBeenCalledWith('shutdown', failure)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('reports main-window startup failure, stops the attempt Harness, and keeps recovery open', async () => {
    const failure = new Error('window setup failed')
    const { app, dependencies, reportFailure, showFailure, stop } = fixture({
      createWindow: vi.fn(async () => { throw failure }),
    })
    const desktop = startDesktopMain(dependencies)

    await desktop.startup

    expect(reportFailure).toHaveBeenCalledWith('startup', failure)
    expect(showFailure).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, status: 'failed' }))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()
  })

  it('reports a Harness startup failure and keeps recovery open without stopping an absent handle', async () => {
    const failure = new Error('supervised startup failed')
    const { app, dependencies, reportFailure, showFailure, stop } = fixture({
      startHarness: vi.fn(async () => { throw failure }),
    })
    const desktop = startDesktopMain(dependencies)

    await desktop.startup

    expect(reportFailure).toHaveBeenCalledWith('startup', failure)
    expect(showFailure).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, status: 'failed' }))
    expect(dependencies.createWindow).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(app.quit).not.toHaveBeenCalled()
  })

  it.each([
    ['win32', true],
    ['linux', true],
    ['darwin', false],
  ] as const)('handles the last closed window on %s without duplicate cleanup', async (platform, quits) => {
    const { app, dependencies, stop } = fixture({ platform })
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    app.emit('window-all-closed')
    await flushLifecycle()
    if (quits) {
      expect(app.quit).toHaveBeenCalledTimes(1)
      app.emitBeforeQuit()
      await desktop.shutdown
      expect(stop).toHaveBeenCalledTimes(1)
    } else {
      expect(app.quit).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
    }
  })

  it('clears a natively closed window before handling a second instance', async () => {
    const { app, closeWindow, dependencies, createWindow, focus, restore } = fixture()
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    closeWindow()
    app.emit('second-instance')

    expect(focus).not.toHaveBeenCalled()
    expect(restore).not.toHaveBeenCalled()
    expect(createWindow).toHaveBeenCalledTimes(1)
  })

  it('recreates and focuses one macOS window after native close and activation', async () => {
    const first = fixture()
    const second = fixture()
    const createWindow = vi.fn()
      .mockResolvedValueOnce(first.window)
      .mockResolvedValueOnce(second.window)
    const { app, dependencies, harness, startHarness } = fixture({ platform: 'darwin', createWindow })
    const desktop = startDesktopMain(dependencies)
    await desktop.startup
    first.closeWindow()

    app.emit('activate')
    app.emit('activate')
    await flushLifecycle()

    expect(startHarness).toHaveBeenCalledTimes(1)
    expect(createWindow).toHaveBeenCalledTimes(2)
    expect(createWindow).toHaveBeenLastCalledWith(harness.endpoint, harness.capability)
    expect(second.focus).toHaveBeenCalledTimes(1)
  })

  it('contains a delayed macOS recreate focus failure', async () => {
    const first = fixture()
    const second = fixture()
    const delayedWindow = deferred<DesktopWindow>()
    const failure = new Error('recreated window focus failed')
    second.focus.mockImplementation(() => { throw failure })
    const createWindow = vi.fn()
      .mockResolvedValueOnce(first.window)
      .mockReturnValueOnce(delayedWindow.promise)
    const { app, dependencies, reportFailure } = fixture({ platform: 'darwin', createWindow })
    const desktop = startDesktopMain(dependencies)
    await desktop.startup
    first.closeWindow()

    app.emit('activate')
    delayedWindow.resolve(second.window)
    await flushLifecycle()

    expect(reportFailure).toHaveBeenCalledWith('callback', failure)
  })

  it('recreates a macOS window for a second instance without calling the stale handle', async () => {
    const first = fixture()
    const second = fixture()
    const createWindow = vi.fn()
      .mockResolvedValueOnce(first.window)
      .mockResolvedValueOnce(second.window)
    const { app, dependencies } = fixture({ platform: 'darwin', createWindow })
    const desktop = startDesktopMain(dependencies)
    await desktop.startup
    first.closeWindow()

    app.emit('second-instance')
    await flushLifecycle()

    expect(first.focus).not.toHaveBeenCalled()
    expect(first.restore).not.toHaveBeenCalled()
    expect(second.focus).toHaveBeenCalledTimes(1)
    expect(createWindow).toHaveBeenCalledTimes(2)
  })

  it('does not recreate a closed macOS window while Harness stop is pending', async () => {
    const stopping = deferred<undefined>()
    const { app, closeWindow, createWindow, dependencies, stop } = fixture({ platform: 'darwin' })
    vi.mocked(stop).mockReturnValue(stopping.promise)
    const desktop = startDesktopMain(dependencies)
    await desktop.startup
    closeWindow()

    app.emitBeforeQuit()
    app.emit('activate')
    app.emit('second-instance')
    await flushLifecycle()

    expect(createWindow).toHaveBeenCalledTimes(1)
    stopping.resolve(undefined)
    await desktop.shutdown
  })

  it('disposes the active window-close subscription during shutdown', async () => {
    const { app, dependencies, disposeClosed } = fixture()
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    app.emitBeforeQuit()
    await desktop.shutdown

    expect(disposeClosed).toHaveBeenCalledTimes(1)
  })

  it('contains event callback and reporting exceptions', async () => {
    const focusFailure = new Error('focus failed')
    const { app, dependencies, focus, stop } = fixture({
      reportFailure: vi.fn(() => { throw new Error('reporter failed') }),
    })
    focus.mockImplementation(() => { throw focusFailure })
    const desktop = startDesktopMain(dependencies)
    await desktop.startup

    expect(() => app.emit('second-instance')).not.toThrow()
    expect(() => app.emit('window-all-closed')).not.toThrow()
    expect(() => app.emitBeforeQuit()).not.toThrow()
    await desktop.shutdown
    expect(stop).toHaveBeenCalledTimes(1)
  })
})
