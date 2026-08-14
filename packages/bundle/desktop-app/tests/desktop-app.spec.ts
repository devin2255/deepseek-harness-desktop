/** Per-launch desktop loopback authorization behavior. */

import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { WebRequestGuard, WebServer } from '@deepseek-ai/dsh-host-webserver'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as DesktopApp from '../src/index.ts'
import { apply, CAPABILITY_ENV, inject } from '../src/index.ts'

let environmentBeforeTest: string | undefined
let compositionRoot: string | undefined
let composition: Context | undefined
const contexts = new Set<Context>()
const desktopManifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../base/cordis.patch.yml', import.meta.url))
const webPatchPath = fileURLToPath(new URL('../../web-app/cordis.patch.yml', import.meta.url))

interface DesktopBundleManifest {
  dsh?: { bundle?: { patch?: unknown } }
}

beforeEach(() => { environmentBeforeTest = process.env[CAPABILITY_ENV] })

afterEach(async () => {
  const activeContexts = [...contexts]
  contexts.clear()
  const activeComposition = composition
  const activeRoot = compositionRoot
  composition = undefined
  compositionRoot = undefined
  try {
    await Promise.all([activeComposition?.fiber.dispose(), ...activeContexts.map(ctx => ctx.fiber.dispose())])
  } finally {
    try {
      if (activeRoot !== undefined) await rm(activeRoot, { recursive: true, force: true })
    } finally {
      if (environmentBeforeTest === undefined) delete process.env.DSH_DESKTOP_CAPABILITY
      else process.env[CAPABILITY_ENV] = environmentBeforeTest
    }
  }
})

/** Construct Node's normalized and distinct header views for one Authorization value. */
function request(authorization: string | undefined): IncomingMessage {
  return {
    headers: authorization === undefined ? {} : { authorization },
    headersDistinct: authorization === undefined ? {} : { authorization: [authorization] },
  } as IncomingMessage
}

/** Mount the plugin around a fake Web server and retain its registered guard. */
async function mountedDesktopRuntime(): Promise<{ ctx: Context; guard: WebRequestGuard; removed: () => boolean }> {
  const ctx = new Context()
  contexts.add(ctx)
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

/** Release one test context without scheduling a second teardown. */
async function disposeContext(ctx: Context): Promise<void> {
  contexts.delete(ctx)
  await ctx.fiber.dispose()
}

/** Compose the manifest-declared desktop patch over the shipped base and Web rows. */
async function readDesktopBundleComposition(): Promise<{ entries: ReturnType<typeof composeEntries>; patch: string }> {
  const manifest = JSON.parse(await readFile(desktopManifestPath, 'utf8')) as DesktopBundleManifest
  const patch = manifest.dsh?.bundle?.patch
  if (typeof patch !== 'string') throw new Error('desktop bundle manifest declares no patch path')
  const patchPath = fileURLToPath(new URL(patch, pathToFileURL(desktopManifestPath)))
  return {
    entries: composeEntries([
      loadOverlayPatches('desktop-app test', basePatchPath),
      loadOverlayPatches('desktop-app test', webPatchPath),
      loadOverlayPatches('desktop-app test', patchPath),
    ]),
    patch,
  }
}

/** Boot the Web server and the desktop plugin by their bare package names. */
async function bootDesktopComposition(): Promise<Context> {
  compositionRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-app-loader-'))
  const configPath = join(compositionRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '    requiredGuards: [desktop-capability]',
    "- name: '@deepseek-ai/dsh-desktop-app'",
    '',
  ].join('\n'))

  composition = new Context()
  composition.baseUrl = pathToFileURL(compositionRoot).href + '/'
  await composition.plugin(Loader)
  composition.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-desktop-app', DesktopApp],
  ])
  composition.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return module
    },
  } as unknown as NonNullable<typeof composition.loader.internal>
  await composition.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await composition.loader.await()
  return composition
}

/** Send raw HTTP header lines and return the server's status line. */
async function rawRequest(port: number, authorization: readonly string[]): Promise<number> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  const chunks: Buffer[] = []
  socket.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
  socket.write([
    'GET /ready HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: close',
    ...authorization.map(value => `Authorization: ${value}`),
    '',
    '',
  ].join('\r\n'))
  await closed
  const status = /^HTTP\/1\.1 (\d{3}) /.exec(Buffer.concat(chunks).toString('utf8'))?.[1]
  if (status === undefined) throw new Error('raw HTTP request received no status line')
  return Number(status)
}

/** Send a raw upgrade request; rejected upgrades close before a status line. */
async function rawUpgrade(port: number, authorization: readonly string[]): Promise<number | undefined> {
  const socket = connect(port, '127.0.0.1')
  socket.on('error', () => {})
  await once(socket, 'connect')
  const closed = once(socket, 'close')
  const chunks: Buffer[] = []
  socket.on('data', (chunk) => { chunks.push(Buffer.from(chunk)) })
  socket.write([
    'GET /events HTTP/1.1',
    `Host: 127.0.0.1:${String(port)}`,
    'Connection: Upgrade',
    'Upgrade: dsh-test',
    ...authorization.map(value => `Authorization: ${value}`),
    '',
    '',
  ].join('\r\n'))
  await closed
  const status = /^HTTP\/1\.1 (\d{3}) /.exec(Buffer.concat(chunks).toString('utf8'))?.[1]
  return status === undefined ? undefined : Number(status)
}

describe('desktop launch capability', () => {
  it('composes the manifest-declared patch over the actual Web bundle rows', async () => {
    const { entries, patch } = await readDesktopBundleComposition()

    expect(patch).toBe('./cordis.patch.yml')
    expect(entries.find(entry => entry.id === 'webserver')).toMatchObject({
      name: '@deepseek-ai/dsh-host-webserver',
      config: {
        host: { __jsExpr: "ctx.webStartup.host ?? '127.0.0.1'" },
        port: { __jsExpr: 'ctx.webStartup.port ?? 3080' },
        requiredGuards: ['desktop-capability'],
      },
    })
    expect(entries.find(entry => entry.id === 'web-runtime')?.config).toEqual({
      printUrl: true,
      surfaceContext: false,
      trustedHosts: [],
    })
    expect(entries.find(entry => entry.id === 'desktop-app')).toMatchObject({
      name: '@deepseek-ai/dsh-desktop-app',
    })
  })

  it('loads the bare desktop plugin and authorizes one exact raw HTTP or upgrade request', async () => {
    process.env[CAPABILITY_ENV] = 'launch-secret'
    const loaded = await bootDesktopComposition()
    loaded.webServer.register({ kind: 'exact', path: '/ready', handler: (_req, res) => { res.end('ready') } })
    loaded.webServer.registerUpgrade({
      path: '/events',
      handler: (_req, socket) => {
        socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: dsh-test\r\n\r\n')
      },
    })

    expect(await rawRequest(loaded.webServer.port, ['Bearer launch-secret'])).toBe(200)
    expect(await rawRequest(loaded.webServer.port, [])).toBe(401)
    expect(await rawRequest(loaded.webServer.port, ['Basic launch-secret'])).toBe(401)
    expect(await rawRequest(loaded.webServer.port, ['Bearer other'])).toBe(401)
    expect(await rawRequest(loaded.webServer.port, ['Bearer launch-secret', 'Bearer other'])).toBe(401)
    expect(await rawRequest(loaded.webServer.port, ['Bearer other', 'Bearer launch-secret'])).toBe(401)
    expect(await rawUpgrade(loaded.webServer.port, ['Bearer launch-secret'])).toBe(101)
    expect(await rawUpgrade(loaded.webServer.port, ['Bearer launch-secret', 'Bearer other'])).toBeUndefined()

    const desktopEntry = [...loaded.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-desktop-app')
    if (desktopEntry?.fiber === undefined) throw new Error('desktop plugin was not mounted by the Loader')
    await desktopEntry.fiber.dispose()
    expect(await rawRequest(loaded.webServer.port, ['Bearer launch-secret'])).toBe(401)
  })

  it.each([undefined, '', ' ', 'launch+secret', 'launch/secret', 'launch=secret', '秘密'])('fails loud and removes an absent, empty, or non-base64url launch capability', async (capability) => {
    if (capability === undefined) delete process.env.DSH_DESKTOP_CAPABILITY
    else process.env[CAPABILITY_ENV] = capability

    const ctx = new Context()
    contexts.add(ctx)
    ctx.provide('webServer', { registerGuard: () => () => {} } as Pick<WebServer, 'registerGuard'> as WebServer)
    await expect(ctx.plugin({ inject: [...inject], apply }))
      .rejects.toThrow('desktop-app: DSH_DESKTOP_CAPABILITY must contain a per-launch capability')
    expect(process.env[CAPABILITY_ENV]).toBeUndefined()
    await disposeContext(ctx)
  })

  it('captures one launch capability and authorizes only its exact bearer value', async () => {
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard, removed } = await mountedDesktopRuntime()
    expect(process.env[CAPABILITY_ENV]).toBeUndefined()
    expect(guard(request('Bearer launch-secret'))).toBe(true)
    expect(guard(request('Bearer other'))).toBe(false)
    expect(guard(request(undefined))).toBe(false)
    await disposeContext(ctx)
    expect(removed()).toBe(true)
  })

  it('rejects malformed Authorization values', async () => {
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard } = await mountedDesktopRuntime()
    for (const authorization of [
      'Basic launch-secret',
      'bearer launch-secret',
      'Bearer',
      'Bearer ',
      'Bearer  launch-secret',
      'Bearer launch-secret ',
    ]) {
      expect(guard(request(authorization))).toBe(false)
    }
    await disposeContext(ctx)
  })

  it('rejects a bearer token whose byte length differs from the captured capability', async () => {
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard } = await mountedDesktopRuntime()
    expect(guard(request('Bearer x'))).toBe(false)
    expect(guard(request('Bearer launch-secret-extra'))).toBe(false)
    await disposeContext(ctx)
  })

  it('continues to authorize after the launch environment entry has been removed', async () => {
    process.env[CAPABILITY_ENV] = 'launch-secret'

    const { ctx, guard } = await mountedDesktopRuntime()
    expect(process.env[CAPABILITY_ENV]).toBeUndefined()
    expect(guard(request('Bearer launch-secret'))).toBe(true)
    await disposeContext(ctx)
  })
})
