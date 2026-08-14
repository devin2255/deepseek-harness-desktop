import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  startDesktopMain,
  type DesktopApp,
  type DesktopMainDependencies,
  type DesktopQuitEvent,
} from '../src/main-lifecycle.ts'
import { HarnessShutdownTimeoutError, type HarnessHandle } from '../src/harness-supervisor.ts'
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
  readonly reportFailure: DesktopMainDependencies['reportFailure']
  readonly startHarness: DesktopMainDependencies['startHarness']
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
  const reportFailure = vi.fn()
  const dependencies: DesktopMainDependencies = {
    app,
    platform: 'win32',
    startHarness,
    createWindow,
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
    reportFailure,
    startHarness: dependencies.startHarness,
    stop,
  }
}

async function flushLifecycle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('startDesktopMain', () => {
  it('enables the Chromium sandbox before readiness and starts one Harness before one window', async () => {
    const ready = deferred<undefined>()
    const events: string[] = []
    const { app, dependencies, harness, createWindow, startHarness } = fixture({
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

    expect(app.calls.slice(0, 2)).toEqual(['enableSandbox', 'requestSingleInstanceLock'])
    expect(events).toEqual(['ready-wait'])
    expect(startHarness).not.toHaveBeenCalled()

    ready.resolve(undefined)
    await desktop.startup

    expect(events).toEqual(['ready-wait', 'ready', 'harness', 'window'])
    expect(startHarness).toHaveBeenCalledTimes(1)
    expect(createWindow).toHaveBeenCalledWith(harness.endpoint, harness.capability)
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
    const signal = vi.mocked(dependencies.startHarness).mock.calls[0]?.[0].signal

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

  it('reports a child-that-never-exits abort rejection once and still latches quit', async () => {
    const failure = new HarnessShutdownTimeoutError(10)
    const { app, dependencies, reportFailure } = fixture({
      startHarness: vi.fn<DesktopMainDependencies['startHarness']>(({ signal }) => new Promise<HarnessHandle>((_resolve, reject) => {
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

  it('reports startup failure, stops a ready Harness, and quits without creating a surviving window', async () => {
    const failure = new Error('window setup failed')
    const { app, dependencies, reportFailure, stop } = fixture({
      createWindow: vi.fn(async () => { throw failure }),
    })
    const desktop = startDesktopMain(dependencies)

    await desktop.startup

    expect(reportFailure).toHaveBeenCalledWith('startup', failure)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(app.quit).toHaveBeenCalledTimes(1)
  })

  it('reports a Harness startup failure and quits without creating or stopping an absent handle', async () => {
    const failure = new Error('supervised startup failed')
    const { app, dependencies, reportFailure, stop } = fixture({
      startHarness: vi.fn(async () => { throw failure }),
    })
    const desktop = startDesktopMain(dependencies)

    await desktop.startup

    expect(reportFailure).toHaveBeenCalledWith('startup', failure)
    expect(dependencies.createWindow).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(app.quit).toHaveBeenCalledTimes(1)
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
