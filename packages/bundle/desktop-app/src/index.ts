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
  delete process.env.DSH_DESKTOP_CAPABILITY
  if (configured === undefined || configured.length === 0) {
    throw new Error(`desktop-app: ${CAPABILITY_ENV} must contain a per-launch capability`)
  }
  const capability = Buffer.from(configured, 'utf8')
  ctx.effect(
    () => ctx.webServer.registerGuard('desktop-capability', req => matchesBearer(req, capability)),
    'desktop-app: loopback capability guard',
  )
}
