import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type { DesktopStartupFailure, DesktopStartupState } from '../src/startup-state.ts'
import {
  createStartupWindow,
  type StartupWindow,
  type StartupWindowActions,
  type StartupWindowDependencies,
  type StartupWindowOptions,
} from '../src/startup-window.ts'

describe('createStartupWindow', () => {
  it('exposes only the startup lifecycle surface', () => {
    expectTypeOf<keyof StartupWindow>().toEqualTypeOf<'closed' | 'focus' | 'publish' | 'showFailure' | 'handoffTo'>()
  })

  it('immediately creates a visible sandboxed window and loads only the local startup file', async () => {
    const fixture = startupFixture()

    await createStartupWindow(fixture.actions, fixture.dependencies)

    expect(fixture.options()).toEqual({
      width: 560,
      height: 420,
      minWidth: 480,
      minHeight: 360,
      show: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: 'C:\\bundle\\startup-preload.cjs',
        sandbox: true,
        webSecurity: true,
      },
    })
    expect(fixture.loaded()).toBe('file:///C:/bundle/startup.html')
    expect(fixture.steps[0]).toBe('create')
  })

  it('rejects UNC file URLs before creating a window while allowing normalized localhost file URLs', async () => {
    const remote = startupFixture(new URL('file://server/share/startup.html'))

    await expect(createStartupWindow(remote.actions, remote.dependencies)).rejects.toThrow(
      'Startup window requires a local file URL',
    )
    expect(remote.steps).toEqual([])

    const local = startupFixture(new URL('file://localhost/C:/bundle/startup.html'))
    await createStartupWindow(local.actions, local.dependencies)
    expect(local.loaded()).toBe('file:///C:/bundle/startup.html')
  })

  it('denies every renderer navigation and new-window request', async () => {
    const fixture = startupFixture()
    await createStartupWindow(fixture.actions, fixture.dependencies)
    const navigation = { preventDefault: vi.fn(), url: 'file:///C:/bundle/startup.html' }

    fixture.navigate()(navigation)
    fixture.redirect()(navigation)

    expect(navigation.preventDefault).toHaveBeenCalledTimes(2)
    expect(fixture.open()).toEqual({ action: 'deny' })
  })

  it('publishes only typed startup state to the owned renderer', async () => {
    const fixture = startupFixture()
    const window = await createStartupWindow(fixture.actions, fixture.dependencies)
    const working: DesktopStartupState = { attempt: 1, phase: 'starting-service', status: 'working' }
    const failure: DesktopStartupFailure = {
      attempt: 1,
      phase: 'failed',
      status: 'failed',
      error: { code: 'service-start-failed', action: 'Retry startup.' },
    }

    window.publish(working)
    window.showFailure(failure)

    expect(fixture.sent).toEqual([
      ['dsh-startup:state', working],
      ['dsh-startup:state', failure],
    ])
  })

  it('accepts actions only from the exact owned renderer and disposes handlers on close', async () => {
    const fixture = startupFixture()
    const window = await createStartupWindow(fixture.actions, fixture.dependencies)

    await fixture.invoke('dsh-startup:retry', 41)
    await expect(fixture.invoke('dsh-startup:retry', 99)).rejects.toThrow('unauthorized startup renderer')
    expect(fixture.actions.retry).toHaveBeenCalledOnce()
    fixture.close()
    await window.closed
    await expect(fixture.invoke('dsh-startup:retry', 41)).rejects.toThrow('No handler')
    expect(fixture.removedChannels).toEqual([
      'dsh-startup:retry',
      'dsh-startup:open-logs',
      'dsh-startup:exit',
    ])
  })

  it('focuses the ready desktop window before closing the startup window', async () => {
    const fixture = startupFixture()
    const startup = await createStartupWindow(fixture.actions, fixture.dependencies)
    const desktop = {
      focus: vi.fn(() => fixture.steps.push('desktop-focus')),
      isMinimized: () => false,
      onClosed: () => () => {},
      restore: vi.fn(),
    }

    const handoff = startup.handoffTo(desktop, vi.fn())
    await handoff

    expect(fixture.steps.slice(-3)).toEqual(['desktop-focus', 'startup-destroy', 'startup-closed'])
  })

  it('uses non-cancelable destruction so handoff cannot wait forever on a canceled close', async () => {
    const fixture = startupFixture(undefined, { cancelClose: true })
    const startup = await createStartupWindow(fixture.actions, fixture.dependencies)
    const desktop = {
      focus: vi.fn(() => fixture.steps.push('desktop-focus')),
      isMinimized: () => false,
      onClosed: () => () => {},
      restore: vi.fn(),
    }

    const handoff = startup.handoffTo(desktop, vi.fn())
    const destroyedBeforeRelease = fixture.destroyed()
    fixture.emitClosed()
    await handoff

    expect(destroyedBeforeRelease).toBe(true)
    expect(fixture.steps).toContain('startup-destroy')
  })

  it('commits handoff after destruction and reports later IPC cleanup errors', async () => {
    const cleanupFailure = new Error('handler cleanup failed')
    const fixture = startupFixture(undefined, { removeHandlerFailure: cleanupFailure })
    const startup = await createStartupWindow(fixture.actions, fixture.dependencies)
    const desktop = {
      focus: vi.fn(() => fixture.steps.push('desktop-focus')),
      isMinimized: () => false,
      onClosed: () => () => {},
      restore: vi.fn(),
    }
    const reportFailure = vi.fn()

    await expect(startup.handoffTo(desktop, reportFailure)).resolves.toBeUndefined()

    expect(fixture.destroyed()).toBe(true)
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Startup window IPC cleanup failed',
    }))
  })

  it('destroys after a failed load, disposes every handler once, and settles closure', async () => {
    const loadFailure = new Error('load failed')
    const fixture = startupFixture(undefined, { cancelClose: true, loadFailure })

    await expect(createStartupWindow(fixture.actions, fixture.dependencies)).rejects.toBe(loadFailure)

    expect(fixture.destroyed()).toBe(true)
    expect(fixture.closedEmissions()).toBe(1)
    expect(fixture.removedChannels).toEqual([
      'dsh-startup:retry',
      'dsh-startup:open-logs',
      'dsh-startup:exit',
    ])
  })

  it('aggregates load, handler cleanup, and destruction failures without repeating cleanup', async () => {
    const loadFailure = new Error('load failed')
    const cleanupFailure = new Error('cleanup failed')
    const destroyFailure = new Error('destroy failed')
    const fixture = startupFixture(undefined, {
      destroyFailure,
      loadFailure,
      removeHandlerFailure: cleanupFailure,
    })

    const rejection = await createStartupWindow(fixture.actions, fixture.dependencies)
      .catch((error: unknown) => error)

    expect(rejection).toBeInstanceOf(AggregateError)
    expect((rejection as AggregateError).errors).toEqual([loadFailure, cleanupFailure, destroyFailure])
    expect(fixture.removedChannels).toEqual([
      'dsh-startup:retry',
      'dsh-startup:open-logs',
      'dsh-startup:exit',
    ])
    expect(fixture.closedEmissions()).toBe(1)
  })
})

describe('startup assets', () => {
  it('uses a restrictive CSP and no remote or inline script resources', async () => {
    const html = await readFile(fileURLToPath(new URL('../src/startup.html', import.meta.url)), 'utf8')
    expect(html).toContain('DeepSeek Harness')
    expect(html).toContain('Content-Security-Policy')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain("style-src 'self'")
    expect(html).toContain('role="progressbar"')
    expect(html).toContain('data-failure-actions')
    expect(html).not.toMatch(/https?:\/\//)
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/)
    expect(html).not.toContain('eval(')
    expect(html).not.toContain("'unsafe-inline'")
  })
})

interface FakeIpcEvent { readonly sender: { readonly id: number } }

interface StartupFixtureOptions {
  readonly cancelClose?: boolean
  readonly destroyFailure?: Error
  readonly loadFailure?: Error
  readonly removeHandlerFailure?: Error
}

function startupFixture(
  htmlUrl = new URL('file:///C:/bundle/startup.html'),
  fixtureOptions: StartupFixtureOptions = {},
): {
  readonly actions: StartupWindowActions & { readonly retry: ReturnType<typeof vi.fn> }
  readonly close: () => void
  readonly closedEmissions: () => number
  readonly dependencies: StartupWindowDependencies
  readonly destroyed: () => boolean
  readonly emitClosed: () => void
  readonly invoke: (channel: string, senderId: number) => Promise<void>
  readonly loaded: () => string
  readonly navigate: () => (event: { preventDefault(): void; readonly url: string }) => void
  readonly open: () => { readonly action: 'deny' }
  readonly options: () => StartupWindowOptions
  readonly redirect: () => (event: { preventDefault(): void; readonly url: string }) => void
  readonly removedChannels: string[]
  readonly sent: [string, DesktopStartupState][]
  readonly steps: string[]
} {
  const steps: string[] = []
  const sent: [string, DesktopStartupState][] = []
  const handlers = new Map<string, (event: FakeIpcEvent) => Promise<void>>()
  const removedChannels: string[] = []
  let options: StartupWindowOptions | undefined
  let loaded: string | undefined
  let navigation: ((event: { preventDefault(): void; readonly url: string }) => void) | undefined
  let redirect: ((event: { preventDefault(): void; readonly url: string }) => void) | undefined
  let open: (() => { readonly action: 'deny' }) | undefined
  let closeListener: (() => void) | undefined
  let destroyed = false
  let didEmitClosed = false
  let didFailRemoval = false
  let closedEmissions = 0
  const emitClosed = (): void => {
    if (didEmitClosed) return
    didEmitClosed = true
    closedEmissions += 1
    steps.push('startup-closed')
    closeListener?.()
  }
  const actions = {
    retry: vi.fn(() => Promise.resolve()),
    openLogs: vi.fn(() => Promise.resolve()),
    exit: vi.fn(() => Promise.resolve()),
  }
  return {
    actions,
    close() {
      emitClosed()
    },
    closedEmissions: () => closedEmissions,
    dependencies: {
      createWindow(value) {
        steps.push('create')
        options = value
        return {
          close() {
            steps.push('startup-close')
            if (fixtureOptions.cancelClose !== true) emitClosed()
          },
          destroy() {
            steps.push('startup-destroy')
            if (fixtureOptions.destroyFailure !== undefined) {
              emitClosed()
              throw fixtureOptions.destroyFailure
            }
            destroyed = true
            emitClosed()
          },
          focus() { steps.push('startup-focus') },
          isDestroyed: () => destroyed,
          isMinimized: () => false,
          restore() { steps.push('startup-restore') },
          once(_event, listener) { closeListener = listener },
          webContents: {
            id: 41,
            on(event, listener) {
              if (event === 'will-navigate') navigation = listener
              if (event === 'will-redirect') redirect = listener
            },
            send(channel, state) { sent.push([channel, state]) },
            setWindowOpenHandler(handler) { open = () => handler({}) },
          },
          loadURL(url) {
            loaded = url
            return fixtureOptions.loadFailure === undefined
              ? Promise.resolve()
              : Promise.reject(fixtureOptions.loadFailure)
          },
        }
      },
      htmlUrl: () => htmlUrl,
      ipcMain: {
        handle(channel, handler) {
          if (handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
          handlers.set(channel, handler)
        },
        removeHandler(channel) {
          removedChannels.push(channel)
          handlers.delete(channel)
          if (fixtureOptions.removeHandlerFailure !== undefined && !didFailRemoval) {
            didFailRemoval = true
            throw fixtureOptions.removeHandlerFailure
          }
        },
      },
      preloadPath: () => 'C:\\bundle\\startup-preload.cjs',
    },
    async invoke(channel, senderId) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`No handler: ${channel}`)
      await handler({ sender: { id: senderId } })
    },
    destroyed: () => destroyed,
    emitClosed,
    loaded() {
      if (loaded === undefined) throw new Error('Expected loaded URL')
      return loaded
    },
    navigate() {
      if (navigation === undefined) throw new Error('Expected navigation handler')
      return navigation
    },
    open() {
      if (open === undefined) throw new Error('Expected open handler')
      return open()
    },
    options() {
      if (options === undefined) throw new Error('Expected options')
      return options
    },
    redirect() {
      if (redirect === undefined) throw new Error('Expected redirect handler')
      return redirect
    },
    removedChannels,
    sent,
    steps,
  }
}
