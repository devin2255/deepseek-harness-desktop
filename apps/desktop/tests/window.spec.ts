import { describe, expect, expectTypeOf, it } from 'vitest'
import { configureAuthorizedSession } from '../src/authorized-session.ts'
import {
  createDesktopWindow,
  type DesktopWindow,
  type DesktopWindowDependencies,
  type DesktopWindowOptions,
  type NavigationDetails,
} from '../src/window.ts'

interface FakeEvent extends NavigationDetails {
  prevented: boolean
}

function desktopWindow(): {
  readonly addCloseListener: (listener: () => void) => void
  readonly dependencies: DesktopWindowDependencies
  readonly options: () => DesktopWindowOptions
  readonly navigation: () => (details: NavigationDetails) => void
  readonly redirect: () => (details: NavigationDetails) => void
  readonly open: () => { readonly action: 'deny' }
  readonly close: () => void
  readonly destroyed: () => boolean
  readonly steps: string[]
} {
  const steps: string[] = []
  let windowOptions: DesktopWindowOptions | undefined
  let navigationListener: ((details: NavigationDetails) => void) | undefined
  let redirectListener: ((details: NavigationDetails) => void) | undefined
  let openHandler: (() => { readonly action: 'deny' }) | undefined
  const closedListeners: (() => void)[] = []
  let wasDestroyed = false
  const dependencies: DesktopWindowDependencies = {
    createWindow(options) {
      steps.push('create')
      windowOptions = options
      return {
        webContents: {
          id: 19,
          on(event, listener) {
            if (event === 'will-navigate') navigationListener = listener
            if (event === 'will-redirect') redirectListener = listener
          },
          setWindowOpenHandler(handler) {
            openHandler = () => handler({})
          },
        },
        loadURL(url) {
          steps.push(`load:${url}`)
          return Promise.resolve()
        },
        destroy() {
          wasDestroyed = true
        },
        focus() {
          steps.push('focus')
        },
        isDestroyed: () => wasDestroyed,
        isMinimized: () => false,
        restore() {
          steps.push('restore')
        },
        once(event, listener) {
          if (event === 'closed') closedListeners.push(listener)
        },
      }
    },
    configureSession() {
      steps.push('configure')
      return {
        bind() {
          steps.push('bind')
        },
        dispose() {
          steps.push('dispose')
        },
      }
    },
    preloadPath: () => 'C:\\bundle\\preload.cjs',
    reportCleanupError() {},
  }
  return {
    addCloseListener(listener) {
      closedListeners.push(listener)
    },
    dependencies,
    options() {
      if (windowOptions === undefined) throw new Error('Expected BrowserWindow options')
      return windowOptions
    },
    navigation() {
      if (navigationListener === undefined) throw new Error('Expected a navigation listener')
      return navigationListener
    },
    redirect() {
      if (redirectListener === undefined) throw new Error('Expected a redirect listener')
      return redirectListener
    },
    open() {
      if (openHandler === undefined) throw new Error('Expected a window-open handler')
      return openHandler()
    },
    close() {
      if (closedListeners.length === 0) throw new Error('Expected a close listener')
      for (const listener of closedListeners) listener()
    },
    destroyed: () => wasDestroyed,
    steps,
  }
}

function navigationEvent(url: string): FakeEvent {
  return {
    prevented: false,
    url,
    preventDefault() {
      this.prevented = true
    },
  }
}

describe('createDesktopWindow', () => {
  it('returns only the native-window lifecycle controls', () => {
    expectTypeOf<keyof DesktopWindow>().toEqualTypeOf<'focus' | 'isMinimized' | 'restore'>()
  })

  it('creates a sandboxed window in the isolated partition and binds authorization before loading', async () => {
    const fixture = desktopWindow()

    const actual = await createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)

    expect(fixture.options()).toEqual({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'dsh-desktop',
        preload: 'C:\\bundle\\preload.cjs',
        sandbox: true,
        webSecurity: true,
      },
    })
    expect(fixture.steps).toEqual(['configure', 'create', 'bind', 'load:http://127.0.0.1:4312/'])
    expect(actual.isMinimized()).toBe(false)
    actual.restore()
    actual.focus()
    expect(fixture.steps).toContain('restore')
    expect(fixture.steps).toContain('focus')
  })

  it('allows only same-origin navigation and redirects, and denies all new windows', async () => {
    const fixture = desktopWindow()
    await createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    const allowed = navigationEvent('http://127.0.0.1:4312/settings')
    fixture.navigation()(allowed)

    expect(allowed.prevented).toBe(false)
    const denied = navigationEvent('https://example.com/')
    fixture.navigation()(denied)
    expect(denied.prevented).toBe(true)
    const allowedRedirect = navigationEvent('http://127.0.0.1:4312/sign-in')
    fixture.redirect()(allowedRedirect)
    expect(allowedRedirect.prevented).toBe(false)
    const deniedRedirect = navigationEvent('https://example.com/')
    fixture.redirect()(deniedRedirect)
    expect(deniedRedirect.prevented).toBe(true)
    expect(fixture.open()).toEqual({ action: 'deny' })
  })

  it('disposes session handlers after the BrowserWindow closes', async () => {
    const fixture = desktopWindow()
    await createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)

    fixture.close()

    expect(fixture.steps).toContain('dispose')
  })

  it('contains close cleanup and reporter failures so later close listeners run', async () => {
    const fixture = desktopWindow()
    const removals: string[] = []
    const reported: unknown[] = []
    await createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', {
      ...fixture.dependencies,
      configureSession: failingCleanupSession(removals),
      reportCleanupError(error: unknown) {
        reported.push(error)
        throw new Error('report failed')
      },
    })
    fixture.addCloseListener(() => {
      fixture.steps.push('later listener')
    })

    expect(() => {
      fixture.close()
    }).not.toThrow()
    expect(removals).toEqual(['request', 'check', 'headers'])
    expect(reported).toHaveLength(1)
    expect(reported[0]).toBeInstanceOf(AggregateError)
    expect(fixture.steps).toContain('later listener')
  })

  it('awaits a failed initial load, removes authorization, and destroys the window', async () => {
    const loadFailure = new Error('load failed')
    const fixture = desktopWindowWithLoadFailure(loadFailure)

    await expect(createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)).rejects.toBe(loadFailure)

    expect(fixture.steps).toEqual(['configure', 'bind', 'load', 'dispose', 'destroy'])
    expect(fixture.destroyed()).toBe(true)
  })

  it('rolls back authorization and the window after every setup failure point', async () => {
    for (const stage of ['preload', 'constructor', 'bind', 'navigate', 'redirect', 'open', 'closed', 'load'] as const) {
      const fixture = desktopWindowWithSetupFailure(stage)

      await expect(createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies))
        .rejects.toBe(fixture.failure)

      if (stage === 'preload') expect(fixture.steps).toEqual(['preload'])
      else expect(fixture.steps).toContain('dispose')
      expect(fixture.destroyed()).toBe(stage !== 'preload' && stage !== 'constructor')
    }
  })

  it('reports both cleanup failures after an initial load failure', async () => {
    const fixture = desktopWindowWithSetupFailure('load', new Set(['dispose', 'destroy']))

    await expect(createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies))
      .rejects.toBeInstanceOf(AggregateError)

    expect(fixture.steps).toContain('dispose')
    expect(fixture.steps).toContain('destroy')
  })
})

function desktopWindowWithLoadFailure(loadFailure: Error): {
  readonly dependencies: DesktopWindowDependencies
  readonly destroyed: () => boolean
  readonly steps: string[]
} {
  const steps: string[] = []
  let wasDestroyed = false
  return {
    dependencies: {
      createWindow() {
        return {
          webContents: {
            id: 19,
            on() {},
            setWindowOpenHandler() {},
          },
          loadURL() {
            steps.push('load')
            return Promise.reject(loadFailure)
          },
          once() {},
          destroy() {
            steps.push('destroy')
            wasDestroyed = true
          },
          focus() {},
          isDestroyed: () => wasDestroyed,
          isMinimized: () => false,
          restore() {},
        }
      },
      configureSession() {
        steps.push('configure')
        return {
          bind() {
            steps.push('bind')
          },
          dispose() {
            steps.push('dispose')
          },
        }
      },
      preloadPath: () => 'C:\\bundle\\preload.cjs',
      reportCleanupError() {},
    },
    destroyed: () => wasDestroyed,
    steps,
  }
}

function desktopWindowWithSetupFailure(
  stage: 'preload' | 'constructor' | 'bind' | 'navigate' | 'redirect' | 'open' | 'closed' | 'load',
  failingCleanup: ReadonlySet<'dispose' | 'destroy'> = new Set(),
): {
  readonly dependencies: DesktopWindowDependencies
  readonly destroyed: () => boolean
  readonly failure: Error
  readonly steps: string[]
} {
  const failure = new Error(`startup ${stage} failed`)
  const steps: string[] = []
  let wasDestroyed = false
  const fail = (target: typeof stage): void => {
    if (stage === target) throw failure
  }
  return {
    dependencies: {
      preloadPath() {
        steps.push('preload')
        fail('preload')
        return 'C:\\bundle\\preload.cjs'
      },
      configureSession() {
        steps.push('configure')
        return {
          bind() {
            steps.push('bind')
            fail('bind')
          },
          dispose() {
            steps.push('dispose')
            if (failingCleanup.has('dispose')) throw new Error('dispose failed')
          },
        }
      },
      createWindow() {
        steps.push('create')
        fail('constructor')
        return {
          webContents: {
            id: 19,
            on(event) {
              steps.push(event)
              if (event === 'will-navigate') fail('navigate')
              if (event === 'will-redirect') fail('redirect')
            },
            setWindowOpenHandler() {
              steps.push('open')
              fail('open')
            },
          },
          loadURL() {
            steps.push('load')
            if (stage === 'load') return Promise.reject(failure)
            return Promise.resolve()
          },
          once() {
            steps.push('closed')
            fail('closed')
          },
          destroy() {
            steps.push('destroy')
            wasDestroyed = true
            if (failingCleanup.has('destroy')) throw new Error('destroy failed')
          },
          focus() {},
          isDestroyed: () => wasDestroyed,
          isMinimized: () => false,
          restore() {},
        }
      },
      reportCleanupError() {},
    },
    destroyed: () => wasDestroyed,
    failure,
    steps,
  }
}

function failingCleanupSession(removals: string[]): DesktopWindowDependencies['configureSession'] {
  return (endpoint, capability) => configureAuthorizedSession(endpoint, capability, {
    fromPartition() {
      const failRemoval = (name: string): never => {
        removals.push(name)
        throw new Error(`remove ${name}`)
      }
      return {
        request: {
          onBeforeSendHeaders(filter) {
            if (filter === null) failRemoval('headers')
          },
        },
        setPermissionCheckHandler(handler) {
          if (handler === null) failRemoval('check')
        },
        setPermissionRequestHandler(handler) {
          if (handler === null) failRemoval('request')
        },
      }
    },
  })
}
