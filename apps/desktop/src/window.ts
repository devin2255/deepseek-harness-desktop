/** Creates the sole sandboxed desktop window after the Harness endpoint is ready. */

import { BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { configureAuthorizedSession, DESKTOP_SESSION_PARTITION, type AuthorizedSession } from './authorized-session.ts'

/** BrowserWindow options owned by the desktop shell. */
export interface DesktopWindowOptions {
  /** Initial window width in device-independent pixels. */
  readonly width: number
  /** Initial window height in device-independent pixels. */
  readonly height: number
  /** Smallest permitted window width. */
  readonly minWidth: number
  /** Smallest permitted window height. */
  readonly minHeight: number
  /** Renderer containment settings. */
  readonly webPreferences: {
    /** Keep page JavaScript separate from preload globals. */
    readonly contextIsolation: boolean
    /** Disable Node.js access in page JavaScript. */
    readonly nodeIntegration: boolean
    /** Use the authorization-owning session partition. */
    readonly partition: string
    /** Absolute path of the packaged CommonJS preload. */
    readonly preload: string
    /** Run the preload and renderer without ambient Node.js APIs. */
    readonly sandbox: boolean
    /** Retain Chromium same-origin enforcement. */
    readonly webSecurity: boolean
  }
}

/** Navigation event data used to reject cross-origin renderer navigation. */
export interface NavigationDetails {
  /** Candidate navigation URL. */
  readonly url: string
  /** Cancel the attempted navigation. */
  preventDefault(): void
}

/** Native-window lifecycle controls returned after desktop startup succeeds. */
export interface DesktopWindow {
  /** Whether the native window is minimized. */
  isMinimized(): boolean
  /** Restore a minimized native window. */
  restore(): void
  /** Focus the native window. */
  focus(): void
}

/** BrowserWindow operations used only while starting and cleaning up the desktop window. */
interface DesktopWindowStartupHandle extends DesktopWindow {
  /** Renderer controls associated with this browser window. */
  readonly webContents: {
    /** Electron's opaque renderer identity. */
    readonly id: number
    /** Listen for renderer navigation and server-initiated redirects. */
    on(event: 'will-navigate' | 'will-redirect', listener: (details: NavigationDetails) => void): void
    /** Deny every renderer request to open a second browser window. */
    setWindowOpenHandler(handler: (details: unknown) => { readonly action: 'deny' }): void
  }
  /** Load the already authorized loopback page. */
  loadURL(url: string): Promise<void>
  /** Whether Electron has already destroyed this native window. */
  isDestroyed(): boolean
  /** Destroy this native window after startup fails. */
  destroy(): void
  /** Dispose session handlers when Electron closes the window. */
  once(event: 'closed', listener: () => void): void
}

/** Production inputs that can be structurally replaced without launching Electron. */
export interface DesktopWindowDependencies {
  /** Create a BrowserWindow with the desktop containment settings. */
  createWindow(options: DesktopWindowOptions): DesktopWindowStartupHandle
  /** Install the isolated session authorization before creating the renderer. */
  configureSession(endpoint: URL, capability: string): AuthorizedSession
  /** Return the absolute packaged preload path. */
  preloadPath(): string
  /** Report a failure raised while removing session handlers after the native window closes. */
  reportCleanupError(error: unknown): void
}

/**
 * Create and start a sandboxed browser window for the exact settled endpoint.
 * @param endpoint - The ready desktop Harness loopback URL.
 * @param capability - The process-private bearer value retained only by the session owner.
 * @param overrides - Production operations replaced by structural fakes in focused tests.
 * @returns The created window after its initial page load succeeds.
 * Rejects after any preload, construction, binding, handler-registration, or load failure.
 * The original error is preserved unless session disposal or window destruction adds cleanup errors.
 */
export async function createDesktopWindow(
  endpoint: URL,
  capability: string,
  overrides: Partial<DesktopWindowDependencies> = {},
): Promise<DesktopWindow> {
  const dependencies = resolveDependencies(overrides)
  let authorization: AuthorizedSession | undefined
  let desktopWindow: DesktopWindowStartupHandle | undefined
  try {
    const preload = dependencies.preloadPath()
    authorization = dependencies.configureSession(endpoint, capability)
    desktopWindow = dependencies.createWindow({
      width: 1280,
      height: 800,
      minWidth: 960,
      minHeight: 640,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: DESKTOP_SESSION_PARTITION,
        preload,
        sandbox: true,
        webSecurity: true,
      },
    })

    authorization.bind(desktopWindow.webContents.id)
    const preventCrossOriginNavigation = (details: NavigationDetails): void => {
      if (!isEndpointNavigation(details.url, endpoint)) details.preventDefault()
    }
    desktopWindow.webContents.on('will-navigate', preventCrossOriginNavigation)
    desktopWindow.webContents.on('will-redirect', preventCrossOriginNavigation)
    desktopWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const activeAuthorization = authorization
    desktopWindow.once('closed', () => {
      disposeAfterClose(activeAuthorization, (error) => {
        dependencies.reportCleanupError(error)
      })
    })
    await desktopWindow.loadURL(endpoint.href)
    return desktopWindow
  } catch (error: unknown) {
    const cleanupErrors = cleanUpStartup(desktopWindow, authorization)
    throw startupCleanupFailure(error, cleanupErrors)
  }
}

/** Contain session disposal and diagnostic-sink failures so Electron can notify later close listeners. */
function disposeAfterClose(authorization: AuthorizedSession, reportCleanupError: (error: unknown) => void): void {
  try {
    authorization.dispose()
  } catch (error: unknown) {
    try {
      reportCleanupError(error)
    } catch {
      // Cleanup reporting is best-effort; its failure must not escape Electron's close listener.
    }
  }
}

/** Dispose session authority and destroy a partially started window without skipping later cleanup. */
function cleanUpStartup(
  window: DesktopWindowStartupHandle | undefined,
  authorization: AuthorizedSession | undefined,
): unknown[] {
  const errors: unknown[] = []
  if (authorization !== undefined) {
    try {
      authorization.dispose()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  if (window !== undefined) {
    try {
      if (!window.isDestroyed()) window.destroy()
    } catch (error: unknown) {
      errors.push(error)
    }
  }
  return errors
}

/** Preserve a startup error unless cleanup produced additional reportable failures. */
function startupCleanupFailure(error: unknown, cleanupErrors: unknown[]): unknown {
  if (cleanupErrors.length === 0) return error
  return new AggregateError([error, ...cleanupErrors], 'Desktop window startup failed and cleanup also failed', { cause: error })
}

/** Resolve Electron operations at the explicit desktop-shell dependency boundary. */
function resolveDependencies(overrides: Partial<DesktopWindowDependencies>): DesktopWindowDependencies {
  return {
    createWindow: options => new BrowserWindow(options),
    configureSession: configureAuthorizedSession,
    preloadPath: () => fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    reportCleanupError: (error) => {
      console.error('Desktop session cleanup failed after window closed:', error)
    },
    ...overrides,
  }
}

/** Check whether a renderer navigation remains at the one permitted HTTP origin. */
function isEndpointNavigation(value: string, endpoint: URL): boolean {
  try {
    const target = new URL(value)
    return target.origin === endpoint.origin && target.protocol === 'http:' && target.username === '' && target.password === ''
  } catch {
    return false
  }
}
