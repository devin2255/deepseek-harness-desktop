import { access, readFile } from 'node:fs/promises'
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

    const handoff = startup.handoffTo(desktop)
    await handoff

    expect(fixture.steps.slice(-3)).toEqual(['desktop-focus', 'startup-close', 'startup-closed'])
  })
})

describe('startup assets', () => {
  it('builds the real CommonJS preload and local HTML assets', async () => {
    const lib = fileURLToPath(new URL('../lib/', import.meta.url))
    await expect(access(`${lib}startup-preload.cjs`)).resolves.toBeUndefined()
    await expect(access(`${lib}startup.html`)).resolves.toBeUndefined()
    await expect(access(`${lib}startup.css`)).resolves.toBeUndefined()
  })

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

function startupFixture(htmlUrl = new URL('file:///C:/bundle/startup.html')): {
  readonly actions: StartupWindowActions & { readonly retry: ReturnType<typeof vi.fn> }
  readonly close: () => void
  readonly dependencies: StartupWindowDependencies
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
  const actions = {
    retry: vi.fn(() => Promise.resolve()),
    openLogs: vi.fn(() => Promise.resolve()),
    exit: vi.fn(() => Promise.resolve()),
  }
  return {
    actions,
    close() {
      steps.push('startup-closed')
      closeListener?.()
    },
    dependencies: {
      createWindow(value) {
        steps.push('create')
        options = value
        return {
          close() {
            steps.push('startup-close')
            steps.push('startup-closed')
            closeListener?.()
          },
          focus() { steps.push('startup-focus') },
          isDestroyed: () => false,
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
          loadURL(url) { loaded = url; return Promise.resolve() },
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
        },
      },
      preloadPath: () => 'C:\\bundle\\startup-preload.cjs',
    },
    async invoke(channel, senderId) {
      const handler = handlers.get(channel)
      if (handler === undefined) throw new Error(`No handler: ${channel}`)
      await handler({ sender: { id: senderId } })
    },
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
