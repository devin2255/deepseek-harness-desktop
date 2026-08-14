/** Per-launch desktop loopback authorization behavior. */

import type { IncomingMessage } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRequestGuard, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, CAPABILITY_ENV, inject } from '../src/index.ts'

let environmentBeforeTest: string | undefined

afterEach(() => {
  if (environmentBeforeTest === undefined) delete process.env.DSH_DESKTOP_CAPABILITY
  else process.env[CAPABILITY_ENV] = environmentBeforeTest
})

/** Construct the only request field the desktop guard examines. */
function request(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage
}

/** Mount the plugin around a fake Web server and retain its registered guard. */
async function mountedDesktopRuntime(): Promise<{ ctx: Context; guard: WebRequestGuard; removed: () => boolean }> {
  const ctx = new Context()
  let guard: WebRequestGuard | undefined
  let registered = false
  ctx.provide('webServer', {
    registerGuard(name: string, candidate: WebRequestGuard): () => void {
      expect(name).toBe('desktop-capability')
      expect(registered).toBe(false)
      registered = true
      guard = candidate
      return () => { registered = false }
    },
  } as Pick<WebServer, 'registerGuard'> as WebServer)
  await ctx.plugin({ inject: [...inject], apply })
  if (guard === undefined) throw new Error('desktop capability guard was not registered')
  return { ctx, guard, removed: () => !registered }
}

describe('desktop launch capability', () => {
  it.each([undefined, ''])('fails loud and removes an absent or empty launch capability', async (capability) => {
    environmentBeforeTest = process.env[CAPABILITY_ENV]
    if (capability === undefined) delete process.env.DSH_DESKTOP_CAPABILITY
    else process.env[CAPABILITY_ENV] = capability

    const ctx = new Context()
    ctx.provide('webServer', { registerGuard: () => () => {} } as Pick<WebServer, 'registerGuard'> as WebServer)
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow('desktop-app: DSH_DESKTOP_CAPABILITY must contain a per-launch capability')
    expect(process.env[CAPABILITY_ENV]).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('captures one launch capability and authorizes only its exact bearer value', async () => {
    environmentBeforeTest = process.env[CAPABILITY_ENV]
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard, removed } = await mountedDesktopRuntime()
    expect(process.env[CAPABILITY_ENV]).toBeUndefined()
    expect(guard(request({ authorization: 'Bearer launch-secret' }))).toBe(true)
    expect(guard(request({ authorization: 'Bearer other' }))).toBe(false)
    expect(guard(request({}))).toBe(false)
    await ctx.fiber.dispose()
    expect(removed()).toBe(true)
  })

  it('rejects malformed and duplicate Authorization values', async () => {
    environmentBeforeTest = process.env[CAPABILITY_ENV]
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard } = await mountedDesktopRuntime()
    for (const authorization of [
      'Basic launch-secret',
      'bearer launch-secret',
      'Bearer',
      'Bearer ',
      'Bearer  launch-secret',
      'Bearer launch-secret ',
      ['Bearer launch-secret', 'Bearer launch-secret'],
    ]) {
      expect(guard(request({ authorization } as IncomingMessage['headers']))).toBe(false)
    }
    await ctx.fiber.dispose()
  })

  it('rejects a bearer token whose byte length differs from the captured capability', async () => {
    environmentBeforeTest = process.env[CAPABILITY_ENV]
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard } = await mountedDesktopRuntime()
    expect(guard(request({ authorization: 'Bearer x' }))).toBe(false)
    expect(guard(request({ authorization: 'Bearer launch-secret-extra' }))).toBe(false)
    await ctx.fiber.dispose()
  })

  it('continues to authorize after the launch environment entry has been removed', async () => {
    environmentBeforeTest = process.env[CAPABILITY_ENV]
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard } = await mountedDesktopRuntime()
    expect(process.env[CAPABILITY_ENV]).toBeUndefined()
    expect(guard(request({ authorization: 'Bearer launch-secret' }))).toBe(true)
    await ctx.fiber.dispose()
  })
})
