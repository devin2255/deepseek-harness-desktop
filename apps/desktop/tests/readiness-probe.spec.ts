/** Authenticated desktop readiness probe behavior. */

import { createServer, type RequestListener, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeDesktopReadiness } from '../src/readiness-probe.ts'

const CAPABILITY = 'private-readiness-capability'
const VERSION = '0.1.0-rc.7'
const REQUIRED = ['host.describe', 'session.list'] as const
const servers = new Set<Server>()

afterEach(async () => {
  const active = [...servers]
  servers.clear()
  await Promise.all(active.map(server => new Promise<void>((resolve) => {
    server.close(() => { resolve() })
  })))
})

async function endpoint(
  handler: RequestListener,
): Promise<URL> {
  const server = createServer(handler)
  servers.add(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}`)
}

function probe(endpointUrl: URL, signal = new AbortController().signal): Promise<{ version: string }> {
  return probeDesktopReadiness({
    endpoint: endpointUrl,
    capability: CAPABILITY,
    expectedVersion: VERSION,
    requiredCapabilities: REQUIRED,
    signal,
  })
}

function jsonResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    product: 'deepseek-harness-desktop',
    version: VERSION,
    capabilities: REQUIRED,
    ...overrides,
  })
}

describe('probeDesktopReadiness', () => {
  it('sends one authenticated GET to the exact readiness route and accepts JSON content-type parameters', async () => {
    const url = await endpoint((req, res) => {
      expect(req.method).toBe('GET')
      expect(req.url).toBe('/.well-known/deepseek-harness-desktop/readiness')
      expect(req.headers.authorization).toBe(`Bearer ${CAPABILITY}`)
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(jsonResponse())
    })

    await expect(probe(url)).resolves.toEqual({ version: VERSION })
  })

  it.each([
    ['wrong status', 503, 'application/json', jsonResponse()],
    ['wrong content type', 200, 'text/plain', jsonResponse()],
    ['wrong product', 200, 'application/json', jsonResponse({ product: 'other' })],
    ['wrong version', 200, 'application/json', jsonResponse({ version: '0.1.0-rc.6' })],
    ['missing capability', 200, 'application/json', jsonResponse({ capabilities: ['host.describe'] })],
    ['malformed JSON', 200, 'application/json', '{broken'],
    ['null JSON value', 200, 'application/json', 'null'],
    ['array JSON value', 200, 'application/json', '[]'],
  ])('rejects a %s without exposing request authority', async (_name, status, contentType, body) => {
    const url = await endpoint((_req, res) => {
      res.writeHead(status, { 'content-type': contentType })
      res.end(body)
    })

    const error = await probe(url).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(CAPABILITY)
    expect((error as Error).message).not.toContain(url.href)
  })

  it('rejects an oversized JSON response before retaining its complete body', async () => {
    const url = await endpoint((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ padding: 'x'.repeat(20 * 1024) }))
    })

    await expect(probe(url)).rejects.toThrow('response exceeded')
  })

  it('rejects readiness fields inherited from Object.prototype', async () => {
    const fields = ['product', 'version', 'capabilities'] as const
    const originalDescriptors = new Map(fields.map(field => [
      field,
      Object.getOwnPropertyDescriptor(Object.prototype, field),
    ]))
    try {
      Object.defineProperties(Object.prototype, {
        product: { configurable: true, value: 'deepseek-harness-desktop' },
        version: { configurable: true, value: VERSION },
        capabilities: { configurable: true, value: REQUIRED },
      })
      const url = await endpoint((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{}')
      })

      await expect(probe(url)).rejects.toThrow('malformed JSON fields')
    } finally {
      for (const field of fields) {
        const descriptor = originalDescriptors.get(field)
        if (descriptor === undefined) Reflect.deleteProperty(Object.prototype, field)
        else Object.defineProperty(Object.prototype, field, descriptor)
      }
    }
  })

  it('rejects caller abort without exposing the bearer capability', async () => {
    const url = await endpoint((_req, _res) => {})
    const controller = new AbortController()
    const result = probe(url, controller.signal)
    controller.abort()

    const error = await result.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(CAPABILITY)
  })

  it('rejects a bounded-deadline timeout without exposing the bearer capability', async () => {
    const url = await endpoint((_req, _res) => {})
    const signal = AbortSignal.timeout(5)

    const error = await probe(url, signal).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(CAPABILITY)
  })

  it.each([
    'https://127.0.0.1:4312',
    'http://localhost:4312',
    'http://127.0.0.1:4312/path',
    'http://user:password@127.0.0.1:4312',
  ])('rejects an untrusted discovered endpoint without sending the capability: %s', async (value) => {
    await expect(probe(new URL(value))).rejects.toThrow('trusted loopback endpoint')
  })
})
