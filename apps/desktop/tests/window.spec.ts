import { describe, expect, it } from 'vitest'
import { createDesktopWindow, type DesktopWindowDependencies, type DesktopWindowOptions, type NavigationDetails } from '../src/window.ts'

interface FakeEvent extends NavigationDetails {
  prevented: boolean
}

function desktopWindow(): {
  readonly dependencies: DesktopWindowDependencies
  readonly options: () => DesktopWindowOptions
  readonly navigation: () => (details: NavigationDetails) => void
  readonly open: () => { readonly action: 'deny' }
  readonly close: () => void
  readonly steps: string[]
} {
  const steps: string[] = []
  let windowOptions: DesktopWindowOptions | undefined
  let navigationListener: ((details: NavigationDetails) => void) | undefined
  let openHandler: (() => { readonly action: 'deny' }) | undefined
  let closedListener: (() => void) | undefined
  const dependencies: DesktopWindowDependencies = {
    createWindow(options) {
      steps.push('create')
      windowOptions = options
      return {
        webContents: {
          id: 19,
          on(event, listener) {
            if (event === 'will-navigate') navigationListener = listener
          },
          setWindowOpenHandler(handler) {
            openHandler = () => handler({})
          },
        },
        loadURL(url) {
          steps.push(`load:${url}`)
          return Promise.resolve()
        },
        once(event, listener) {
          if (event === 'closed') closedListener = listener
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
  }
  return {
    dependencies,
    options() {
      if (windowOptions === undefined) throw new Error('Expected BrowserWindow options')
      return windowOptions
    },
    navigation() {
      if (navigationListener === undefined) throw new Error('Expected a navigation listener')
      return navigationListener
    },
    open() {
      if (openHandler === undefined) throw new Error('Expected a window-open handler')
      return openHandler()
    },
    close() {
      if (closedListener === undefined) throw new Error('Expected a close listener')
      closedListener()
    },
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
  it('creates a sandboxed window in the isolated partition and binds authorization before loading', () => {
    const fixture = desktopWindow()

    createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)

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
  })

  it('allows only navigation at the exact desktop origin and denies all new windows', () => {
    const fixture = desktopWindow()
    createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)
    const allowed = navigationEvent('http://127.0.0.1:4312/settings')
    fixture.navigation()(allowed)

    expect(allowed.prevented).toBe(false)
    const denied = navigationEvent('https://example.com/')
    fixture.navigation()(denied)
    expect(denied.prevented).toBe(true)
    expect(fixture.open()).toEqual({ action: 'deny' })
  })

  it('disposes session handlers after the BrowserWindow closes', () => {
    const fixture = desktopWindow()
    createDesktopWindow(new URL('http://127.0.0.1:4312'), 'capability', fixture.dependencies)

    fixture.close()

    expect(fixture.steps).toContain('dispose')
  })
})
