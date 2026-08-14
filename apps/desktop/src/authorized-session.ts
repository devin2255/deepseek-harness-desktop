/** Owns the isolated Electron session that grants the desktop window access to its loopback Harness endpoint. */

import { session } from 'electron'

/** The non-persistent Electron partition used only by the desktop application window. */
export const DESKTOP_SESSION_PARTITION = 'dsh-desktop'

/** HTTP and WebSocket request fields provided before sending an authorization header. */
export interface BeforeSendHeadersDetails {
  /** Request URL supplied by Electron. */
  readonly url: string
  /** Renderer resource category supplied by Electron; exact origin and renderer identity control authorization. */
  readonly resourceType: string
  /** Existing request headers retained unless they are a prior authorization value. */
  readonly requestHeaders: Record<string, string | string[]>
  /** Renderer identity when Electron can associate the request with a webContents. */
  readonly webContentsId?: number
}

/** Completes a request-header decision. */
export type BeforeSendHeadersCallback = (response: {
  readonly cancel?: boolean
  readonly requestHeaders?: Record<string, string | string[]>
}) => void

/** Electron's one-per-event web request listener. */
export type BeforeSendHeadersListener = (details: BeforeSendHeadersDetails, callback: BeforeSendHeadersCallback) => void

/** Denies an Electron permission check regardless of its permission category. */
type PermissionCheckHandler = (
  webContents: unknown,
  permission: string,
  requestingOrigin: string,
  details: unknown,
) => boolean

/** Denies an Electron permission request regardless of its permission category. */
type PermissionRequestHandler = (
  webContents: unknown,
  permission: string,
  callback: (permissionGranted: boolean) => void,
  details: unknown,
) => void

/** The isolated-session methods required by the authorization owner. */
interface IsolatedSession {
  /** The web-request API on which Electron permits exactly one listener for each event. */
  readonly request: {
    /** Register or remove the session's sole before-send-headers listener. */
    onBeforeSendHeaders(
      filter: { readonly urls: string[] } | null,
      listener?: BeforeSendHeadersListener | null,
    ): void
  }
  /** Install or clear the session-wide permission-check decision. */
  setPermissionCheckHandler(handler: PermissionCheckHandler | null): void
  /** Install or clear the session-wide permission-request decision. */
  setPermissionRequestHandler(handler: PermissionRequestHandler | null): void
}

/** Production inputs that can be replaced by structural fakes without launching Electron. */
export interface AuthorizedSessionDependencies {
  /** Resolves the isolated non-persistent desktop partition. */
  fromPartition(partition: string, options: { readonly cache: boolean }): IsolatedSession
}

/** A configured session whose request authority can be bound to one renderer. */
export interface AuthorizedSession {
  /** Bind authorization to one intended Electron webContents before loading the endpoint. */
  bind(webContentsId: number): void
  /** Remove session-wide listeners and permission handlers once the window closes. */
  dispose(): void
}

/**
 * Configure the desktop's isolated session for one exact loopback origin.
 * Electron permits one `onBeforeSendHeaders` listener per event, so this owner must
 * be disposed before a replacement window configures the same isolated session.
 * @param endpoint - The settled Harness endpoint, restricted to a bare loopback HTTP origin.
 * @param capability - The process-private bearer value injected only into matching requests.
 * @param overrides - Electron session access replaced by structural fakes in focused tests.
 * @returns A renderer-bound authorization owner that never exposes the capability.
 */
export function configureAuthorizedSession(
  endpoint: URL,
  capability: string,
  overrides: Partial<AuthorizedSessionDependencies> = {},
): AuthorizedSession {
  if (!isSettledEndpoint(endpoint)) throw new Error('Desktop endpoint must be a loopback HTTP origin with a valid port')
  const dependencies = resolveDependencies(overrides)
  const isolatedSession = dependencies.fromPartition(DESKTOP_SESSION_PARTITION, { cache: true })
  const port = effectivePort(endpoint)
  let webContentsId: number | undefined
  let disposed = false

  const onBeforeSendHeaders: BeforeSendHeadersListener = (details, callback) => {
    if (!matchesEndpointRequest(details.url, port)) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }
    if (webContentsId === undefined || details.webContentsId !== webContentsId) {
      callback({ cancel: true })
      return
    }
    callback({ requestHeaders: injectAuthorization(details.requestHeaders, capability) })
  }

  isolatedSession.request.onBeforeSendHeaders(
    { urls: [`http://127.0.0.1:${port}/*`, `ws://127.0.0.1:${port}/*`] },
    onBeforeSendHeaders,
  )
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback, _details) => {
    callback(false)
  })

  return {
    bind(id) {
      if (disposed) throw new Error('Desktop session authorization is disposed')
      webContentsId = id
    },
    dispose() {
      if (disposed) return
      disposed = true
      webContentsId = undefined
      isolatedSession.request.onBeforeSendHeaders(null)
      isolatedSession.setPermissionCheckHandler(null)
      isolatedSession.setPermissionRequestHandler(null)
    },
  }
}

/** Resolve Electron's session manager at the explicit dependency boundary. */
function resolveDependencies(overrides: Partial<AuthorizedSessionDependencies>): AuthorizedSessionDependencies {
  return {
    fromPartition(partition, options) {
      const isolatedSession = session.fromPartition(partition, options)
      return {
        request: {
          onBeforeSendHeaders(filter, listener) {
            if (filter === null || listener === null || listener === undefined) {
              isolatedSession.webRequest.onBeforeSendHeaders(null)
              return
            }
            isolatedSession.webRequest.onBeforeSendHeaders(filter, listener)
          },
        },
        setPermissionCheckHandler(handler) {
          if (handler === null) {
            isolatedSession.setPermissionCheckHandler(null)
            return
          }
          isolatedSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
            return handler(webContents, permission, requestingOrigin, details)
          })
        },
        setPermissionRequestHandler(handler) {
          if (handler === null) {
            isolatedSession.setPermissionRequestHandler(null)
            return
          }
          isolatedSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
            handler(webContents, permission, callback, details)
          })
        },
      }
    },
    ...overrides,
  }
}

/** Check that a readiness endpoint is a bare HTTP loopback URL with an explicit valid port. */
function isSettledEndpoint(endpoint: URL): boolean {
  return endpoint.protocol === 'http:'
    && endpoint.hostname === '127.0.0.1'
    && endpoint.username === ''
    && endpoint.password === ''
    && endpoint.pathname === '/'
    && endpoint.search === ''
    && endpoint.hash === ''
    && isValidPort(effectivePort(endpoint))
}

/** Check that a request remains an HTTP or WebSocket request at the authorized endpoint. */
function matchesEndpointRequest(value: string, port: string): boolean {
  try {
    const request = new URL(value)
    return (request.protocol === 'http:' || request.protocol === 'ws:')
      && request.hostname === '127.0.0.1'
      && effectivePort(request) === port
      && request.username === ''
      && request.password === ''
  } catch {
    return false
  }
}

/** Return the explicit or protocol-default port used for exact origin comparison. */
function effectivePort(url: URL): string {
  if (url.port !== '') return url.port
  switch (url.protocol) {
    case 'http:':
    case 'ws:':
      return '80'
    case 'https:':
    case 'wss:':
      return '443'
    default:
      return ''
  }
}

/** Check an explicit decimal TCP port without accepting URL defaults or partial numbers. */
function isValidPort(port: string): boolean {
  return /^[1-9][0-9]{0,4}$/u.test(port) && Number(port) <= 65_535
}

/** Preserve non-authorization headers while replacing every case-insensitive authorization header. */
function injectAuthorization(
  requestHeaders: Record<string, string | string[]>,
  capability: string,
): Record<string, string | string[]> {
  return {
    ...Object.fromEntries(Object.entries(requestHeaders).filter(([name]) => name.toLowerCase() !== 'authorization')),
    Authorization: `Bearer ${capability}`,
  }
}
