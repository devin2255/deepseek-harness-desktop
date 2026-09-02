/**
 * @deepseek-ai/dsh-desktop-app — desktop profile authorization for the local
 * Web server. The Electron launcher supplies one process-local capability;
 * this plugin captures and removes it before registering the request guard.
 * @module @deepseek-ai/dsh-desktop-app
 */

import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'desktop-app'
/** Service required to register the desktop request guard. */
export const inject = ['webServer']
/** Environment variable containing one launch-specific local capability. */
export const CAPABILITY_ENV = 'DSH_DESKTOP_CAPABILITY'
/** Environment variable containing the desktop application version expected by the launcher. */
export const DESKTOP_VERSION_ENV = 'DSH_DESKTOP_APP_VERSION'
/** Exact route probed before the desktop renderer receives the Harness endpoint. */
export const READINESS_PATH = '/.well-known/deepseek-harness-desktop/readiness'
const DESKTOP_PRODUCT = 'deepseek-harness-desktop'
const DESKTOP_CAPABILITIES = ['host.describe', 'session.list'] as const

/**
 * Return whether a value is one 32-byte launcher capability encoded without Base64 padding.
 * @param value - Candidate inherited from the supervised desktop process.
 * @returns Whether the candidate has the exact launcher encoding.
 */
export function isDesktopLaunchCapability(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{43}$/u.test(value)
}

/** Match one exact Base64url bearer capability without exposing it. */
function matchesBearer(req: IncomingMessage, capability: Buffer): boolean {
  if (req.headersDistinct.authorization?.length !== 1) return false
  const authorization = req.headers.authorization
  if (typeof authorization !== 'string') return false
  const match = /^Bearer ([A-Za-z0-9_-]+)$/.exec(authorization)
  if (match === null) return false
  const suppliedValue = match[1]
  if (suppliedValue === undefined) return false
  const supplied = Buffer.from(suppliedValue, 'utf8')
  return supplied.length === capability.length && timingSafeEqual(supplied, capability)
}

/**
 * Capture the launcher capability and protect every Web request for this fiber.
 * @param ctx - plugin context carrying the Web server service.
 */
export function apply(ctx: Context): void {
  const configured = process.env[CAPABILITY_ENV]
  const version = process.env[DESKTOP_VERSION_ENV]
  delete process.env.DSH_DESKTOP_CAPABILITY
  delete process.env.DSH_DESKTOP_APP_VERSION
  if (!isDesktopLaunchCapability(configured)) {
    throw new Error(`desktop-app: ${CAPABILITY_ENV} must contain a per-launch capability`)
  }
  if (version === undefined || version.length === 0 || version.length > 128) {
    throw new Error(`desktop-app: ${DESKTOP_VERSION_ENV} must contain the desktop application version`)
  }
  const capability = Buffer.from(configured, 'utf8')
  ctx.effect(
    () => ctx.webServer.registerGuard('desktop-capability', req => matchesBearer(req, capability)),
    'desktop-app: loopback capability guard',
  )
  ctx.inject(['apiProxy'], (apiCtx) => {
    apiCtx.effect(() => apiCtx.webServer.register({
      kind: 'exact',
      path: READINESS_PATH,
      handler(req, res) {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET', 'content-type': 'text/plain; charset=utf-8' })
          res.end('method not allowed')
          return
        }
        const body = JSON.stringify({ product: DESKTOP_PRODUCT, version, capabilities: DESKTOP_CAPABILITIES })
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-store',
        })
        res.end(body)
      },
    }), 'desktop-app: authenticated readiness route')
  })
}
