/** Owns the immediate local startup and recovery BrowserWindow. */

import { BrowserWindow, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  STARTUP_EXIT_CHANNEL,
  STARTUP_OPEN_LOGS_CHANNEL,
  STARTUP_RETRY_CHANNEL,
  STARTUP_STATE_CHANNEL,
} from './startup-ipc.ts'
import type { DesktopStartupFailure, DesktopStartupState } from './startup-state.ts'
import type { DesktopWindow } from './window.ts'

/** BrowserWindow options fixed by the startup-window security policy. */
export interface StartupWindowOptions {
  /** Initial width in device-independent pixels. */
  readonly width: number
  /** Initial height in device-independent pixels. */
  readonly height: number
  /** Smallest permitted width. */
  readonly minWidth: number
  /** Smallest permitted height. */
  readonly minHeight: number
  /** Display the local recovery surface immediately. */
  readonly show: true
  /** Renderer containment settings. */
  readonly webPreferences: {
    /** Keep page JavaScript separate from preload globals. */
    readonly contextIsolation: true
    /** Disable Node.js access in page JavaScript. */
    readonly nodeIntegration: false
    /** Absolute path of the packaged startup preload. */
    readonly preload: string
    /** Run the preload and renderer without ambient Node.js APIs. */
    readonly sandbox: true
    /** Retain Chromium same-origin enforcement. */
    readonly webSecurity: true
  }
}

/** User actions owned by the desktop lifecycle rather than the renderer. */
export interface StartupWindowActions {
  /** Begin one fresh startup attempt. */
  retry(): Promise<void>
  /** Open the owned diagnostic-log location. */
  openLogs(): Promise<void>
  /** Shut down the desktop application. */
  exit(): Promise<void>
}

/** Immediate startup-window controls retained by the desktop lifecycle. */
export interface StartupWindow {
  /** Settles after the native window has closed and its IPC handlers are removed. */
  readonly closed: Promise<void>
  /** Restore and focus the native startup window. */
  focus(): void
  /** Publish one renderer-safe lifecycle state. */
  publish(state: DesktopStartupState): void
  /** Publish one renderer-safe failure state. */
  showFailure(failure: DesktopStartupFailure): void
  /** Focus the ready desktop window, destroy this window, and await handler disposal. */
  handoffTo(window: DesktopWindow): Promise<void>
}

interface StartupNativeWindow {
  readonly webContents: {
    readonly id: number
    on(event: 'will-navigate' | 'will-redirect', listener: (event: { preventDefault(): void }) => void): void
    send(channel: string, state: DesktopStartupState): void
    setWindowOpenHandler(handler: (details: unknown) => { readonly action: 'deny' }): void
  }
  destroy(): void
  focus(): void
  isDestroyed(): boolean
  isMinimized(): boolean
  restore(): void
  once(event: 'closed', listener: () => void): void
  loadURL(url: string): Promise<void>
}

interface StartupIpcMain {
  handle(channel: string, listener: (event: { readonly sender: { readonly id: number } }) => Promise<void>): void
  removeHandler(channel: string): void
}

/** Electron operations replaceable only at the focused-test boundary. */
export interface StartupWindowDependencies {
  /** Create a BrowserWindow with the fixed security policy. */
  createWindow(options: StartupWindowOptions): StartupNativeWindow
  /** Return the fixed local startup document URL. */
  htmlUrl(): URL
  /** IPC registry used to own action handlers for this window's renderer. */
  readonly ipcMain: StartupIpcMain
  /** Return the absolute packaged CommonJS preload path. */
  preloadPath(): string
}

/**
 * Create and load the immediate local startup window.
 * @param actions - Lifecycle-owned recovery operations exposed through fixed IPC channels.
 * @param overrides - Electron operations replaced by structural fakes in focused tests.
 * @returns The loaded startup window and its close lifecycle.
 */
export async function createStartupWindow(
  actions: StartupWindowActions,
  overrides: Partial<StartupWindowDependencies> = {},
): Promise<StartupWindow> {
  const dependencies = resolveDependencies(overrides)
  const htmlUrl = dependencies.htmlUrl()
  if (
    htmlUrl.protocol !== 'file:'
    || htmlUrl.username !== ''
    || htmlUrl.password !== ''
    || htmlUrl.hostname !== ''
  ) {
    throw new Error('Startup window requires a local file URL')
  }
  const nativeWindow = dependencies.createWindow({
    width: 560,
    height: 420,
    minWidth: 480,
    minHeight: 360,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: dependencies.preloadPath(),
      sandbox: true,
      webSecurity: true,
    },
  })

  const registeredChannels: string[] = []
  const cleanupErrors: unknown[] = []
  const terminationErrors: unknown[] = []
  let closed = false
  let handlersDisposed = false
  let terminationRequested = false
  let settleClosed!: (error?: AggregateError) => void
  const closedPromise = new Promise<void>((resolve, reject) => {
    settleClosed = (error) => {
      if (error === undefined) resolve()
      else reject(error)
    }
  })
  // The public promise retains the rejection; this companion prevents an unobserved close from reaching the process.
  void closedPromise.catch(() => {})
  const disposeHandlers = (): void => {
    if (handlersDisposed) return
    handlersDisposed = true
    for (const channel of registeredChannels.splice(0)) {
      try {
        dependencies.ipcMain.removeHandler(channel)
      } catch (error: unknown) {
        cleanupErrors.push(error)
      }
    }
  }
  const finalizeClosed = (): void => {
    if (closed) return
    closed = true
    disposeHandlers()
    settleClosed(cleanupErrors.length === 0
      ? undefined
      : new AggregateError([...cleanupErrors], 'Startup window IPC cleanup failed'))
  }
  const terminate = (): readonly unknown[] => {
    if (terminationRequested) return terminationErrors
    terminationRequested = true
    disposeHandlers()
    terminationErrors.push(...cleanupErrors)
    if (!closed) {
      try {
        if (!nativeWindow.isDestroyed()) nativeWindow.destroy()
      } catch (error: unknown) {
        terminationErrors.push(error)
      }
    }
    finalizeClosed()
    return terminationErrors
  }

  try {
    const preventNavigation = (event: { preventDefault(): void }): void => {
      event.preventDefault()
    }
    nativeWindow.webContents.on('will-navigate', preventNavigation)
    nativeWindow.webContents.on('will-redirect', preventNavigation)
    nativeWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    nativeWindow.once('closed', finalizeClosed)
    registerAction(dependencies, nativeWindow.webContents.id, STARTUP_RETRY_CHANNEL, () => actions.retry(), registeredChannels)
    registerAction(dependencies, nativeWindow.webContents.id, STARTUP_OPEN_LOGS_CHANNEL, () => actions.openLogs(), registeredChannels)
    registerAction(dependencies, nativeWindow.webContents.id, STARTUP_EXIT_CHANNEL, () => actions.exit(), registeredChannels)
    await nativeWindow.loadURL(htmlUrl.href)
  } catch (error: unknown) {
    const errors = terminate()
    if (errors.length === 0) throw error
    throw new AggregateError(
      [error, ...errors],
      'Startup window creation failed and cleanup also failed',
      { cause: error },
    )
  }

  return {
    closed: closedPromise,
    focus() {
      if (nativeWindow.isDestroyed()) return
      if (nativeWindow.isMinimized()) nativeWindow.restore()
      nativeWindow.focus()
    },
    publish(state) {
      if (!closed && !nativeWindow.isDestroyed()) nativeWindow.webContents.send(STARTUP_STATE_CHANNEL, state)
    },
    showFailure(failure) {
      if (!closed && !nativeWindow.isDestroyed()) nativeWindow.webContents.send(STARTUP_STATE_CHANNEL, failure)
    },
    async handoffTo(window) {
      window.focus()
      const errors = terminate()
      await closedPromise.catch((error: unknown) => { void error })
      if (errors.length !== 0) throw new AggregateError([...errors], 'Startup window handoff failed')
    },
  }
}

/** Register one action with an immutable owned-renderer identity check. */
function registerAction(
  dependencies: StartupWindowDependencies,
  rendererId: number,
  channel: string,
  action: () => Promise<void>,
  registeredChannels: string[],
): void {
  dependencies.ipcMain.handle(channel, async (event) => {
    if (event.sender.id !== rendererId) throw new Error('Rejected unauthorized startup renderer')
    await action()
  })
  registeredChannels.push(channel)
}

/** Bind production Electron operations without exposing security settings to callers. */
function resolveDependencies(overrides: Partial<StartupWindowDependencies>): StartupWindowDependencies {
  return {
    createWindow: options => new BrowserWindow(options),
    htmlUrl: () => new URL('./startup.html', import.meta.url),
    ipcMain,
    preloadPath: () => fileURLToPath(new URL('./startup-preload.cjs', import.meta.url)),
    ...overrides,
  }
}
