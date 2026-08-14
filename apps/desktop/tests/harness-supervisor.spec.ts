import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('tests inject utilityProcess.fork')
    },
  },
}))

import {
  HarnessShutdownTimeoutError,
  startHarness,
  type HarnessSupervisorDependencies,
} from '../src/harness-supervisor.ts'

class FakeOutput extends EventEmitter {
  write(chunk: string | Uint8Array): void {
    this.emit('data', chunk)
  }
}

class FakeUtilityProcess extends EventEmitter {
  readonly stdout = new FakeOutput()
  readonly stderr = new FakeOutput()
  readonly kill = vi.fn(() => true)

  exit(code = 0): void {
    this.emit('exit', code)
  }
}

function harness(overrides: Partial<HarnessSupervisorDependencies> = {}): {
  readonly child: FakeUtilityProcess
  readonly dependencies: HarnessSupervisorDependencies
  readonly fork: ReturnType<typeof vi.fn>
} {
  const child = new FakeUtilityProcess()
  const fork = vi.fn(() => child)
  const dependencies: HarnessSupervisorDependencies = {
    fork,
    resolveCli: () => '/fixture/dsh/lib/bin.js',
    randomBytes: size => Buffer.alloc(size, 0xab),
    cwd: () => '/fixture/cwd',
    environment: { FROM_PARENT: 'kept' },
    shutdownTimeoutMs: 10,
    startupTimeoutMs: 10,
    ...overrides,
  }
  return { child, dependencies, fork }
}

async function rejectedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw new Error(`Expected an Error rejection, received ${String(error)}`)
  }
  throw new Error('Expected the promise to reject')
}

describe('startHarness', () => {
  it('forks the desktop profile with a fresh base64url capability and copied environment', async () => {
    const { child, dependencies, fork } = harness()
    const start = startHarness(dependencies)

    expect(fork).toHaveBeenCalledWith('/fixture/dsh/lib/bin.js', ['--profile', 'desktop', '--port', '0'], {
      cwd: '/fixture/cwd',
      env: {
        FROM_PARENT: 'kept',
        DSH_DESKTOP_CAPABILITY: 'q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s',
      },
      serviceName: 'DeepSeek Harness Runtime',
      stdio: 'pipe',
    })
    expect(fork).toHaveBeenCalledTimes(1)
    expect(dependencies.environment).toEqual({ FROM_PARENT: 'kept' })

    child.stdout.write('booting\ndsh web: http://127.0.0.1:4312\n')
    const handle = await start
    expect(handle.endpoint).toEqual(new URL('http://127.0.0.1:4312'))
    expect(handle.capability).toHaveLength(43)
  })

  it('resolves the installed Harness CLI when tests inject only the fork boundary', async () => {
    const { child, fork } = harness()
    const start = startHarness({
      fork,
      randomBytes: size => Buffer.alloc(size, 0xab),
      cwd: () => '/fixture/cwd',
      environment: { FROM_PARENT: 'kept' },
      shutdownTimeoutMs: 10,
      startupTimeoutMs: 10,
    })

    expect(fork).toHaveBeenCalledWith(expect.stringMatching(/apps[\\/]cli[\\/]lib[\\/]bin\.js$/u), expect.any(Array), expect.any(Object))
    child.stdout.write('dsh web: http://127.0.0.1:4313\n')
    await expect(start).resolves.toMatchObject({ endpoint: new URL('http://127.0.0.1:4313') })
  })

  it('waits for a readiness line split across stdout chunks and ignores other output', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)

    child.stdout.write('notice\ndsh web: http://127.0.0.')
    child.stdout.write('1:4301 (LAN: http://192.168.1.2:4301)\n')

    await expect(start).resolves.toMatchObject({ endpoint: new URL('http://127.0.0.1:4301') })
  })

  it('rejects an early exit with a bounded stderr tail and never exposes the capability', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    const error = rejectedError(start)
    const secret = Buffer.alloc(32, 0xab).toString('base64url')

    child.stderr.write('prefix\n')
    child.stderr.write('x'.repeat(9 * 1024))
    child.stderr.write(`\nsecret=${secret}\nfinal diagnostic`)
    child.exit(17)

    const actual = await error
    expect(actual.message).toMatch(/final diagnostic/)
    expect(actual.message).toMatch(/Harness exited before readiness.*17/u)
    expect(actual.message).not.toContain(secret)
    expect(Buffer.byteLength(actual.message)).toBeLessThanOrEqual(8 * 1024 + 100)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('does not emit a capability suffix when tail retention cuts through a capability split across stderr chunks', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    const error = rejectedError(start)
    const secret = Buffer.alloc(32, 0xab).toString('base64url')

    child.stderr.write(secret.slice(0, 21))
    child.stderr.write(secret.slice(21))
    child.stderr.write('x'.repeat(8 * 1024 - 10))
    child.exit(18)

    const actual = await error
    expect(actual.message).not.toContain(secret.slice(10))
    expect(actual.message).not.toContain(secret.slice(21))
    expect(actual.message).not.toContain(secret.slice(33))
    expect(actual.message).not.toContain(secret)
  })

  it('redacts an overlapping all-A capability whether stderr delivers it whole or split', async () => {
    const secret = 'A'.repeat(43)
    const variants = [
      [secret, '!'],
      [secret.slice(0, 21), secret.slice(21), '!'],
    ]

    for (const chunks of variants) {
      const { child, dependencies } = harness({ randomBytes: size => Buffer.alloc(size) })
      const start = startHarness(dependencies)
      const error = rejectedError(start)

      for (const chunk of chunks) child.stderr.write(chunk)
      child.exit(20)

      const actual = await error
      expect(actual.message).toContain('[redacted]!')
      expect(actual.message).not.toContain(secret)
      expect(actual.message).not.toMatch(/A{8}/u)
    }
  })

  it('redacts all-A capability prefixes that end at stderr EOF', async () => {
    const secret = 'A'.repeat(43)

    for (const length of [42, 43]) {
      const { child, dependencies } = harness({ randomBytes: size => Buffer.alloc(size) })
      const start = startHarness(dependencies)
      const error = rejectedError(start)

      child.stderr.write(secret.slice(0, length))
      child.exit(21)

      const actual = await error
      expect(actual.message).toContain('[redacted]')
      expect(actual.message).not.toMatch(/A{8}/u)
    }
  })

  it('preserves unrelated diagnostics while redacting a non-repetitive capability prefix at stderr EOF', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    const error = rejectedError(start)
    const secret = Buffer.alloc(32, 0xab).toString('base64url')

    child.stderr.write(`unrelated diagnostic\n${secret.slice(0, 31)}`)
    child.exit(22)

    const actual = await error
    expect(actual.message).toContain('unrelated diagnostic')
    expect(actual.message).toContain('[redacted]')
    expect(actual.message).not.toContain(secret.slice(0, 8))
  })

  it('keeps an invalid UTF-8 and multibyte stderr diagnostic byte-bounded', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    const error = rejectedError(start)

    child.stderr.write(Uint8Array.from([0xff, 0xe7, 0x95]))
    child.stderr.write('界'.repeat(3_000))
    child.stderr.write('final diagnostic')
    child.exit(19)

    const actual = await error
    expect(actual.message).toContain('final diagnostic')
    expect(Buffer.byteLength(actual.message)).toBeLessThanOrEqual(8 * 1024 + 100)
  })

  it('removes stdout and stderr listeners after readiness', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)

    child.stdout.write('dsh web: http://127.0.0.1:4302\n')
    await start

    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('kills exactly once and shares the in-flight stop promise until the child exits', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    child.stdout.write('dsh web: http://127.0.0.1:4303\n')
    const handle = await start

    const first = handle.stop()
    const second = handle.stop()
    expect(first).toBe(second)
    expect(child.kill).toHaveBeenCalledTimes(1)

    child.exit()
    await expect(Promise.all([first, second, handle.stop()])).resolves.toEqual([undefined, undefined, undefined])
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('does not hang or kill an already exited child', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    child.stdout.write('dsh web: http://127.0.0.1:4304\n')
    const handle = await start
    child.exit()

    await expect(handle.stop()).resolves.toBeUndefined()
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('rejects a stop that does not reach exit before the configured timeout', async () => {
    vi.useFakeTimers()
    try {
      const { child, dependencies } = harness({ shutdownTimeoutMs: 10 })
      const start = startHarness(dependencies)
      child.stdout.write('dsh web: http://127.0.0.1:4305\n')
      const handle = await start

      const stop = handle.stop()
      const rejection = expect(stop).rejects.toBeInstanceOf(HarnessShutdownTimeoutError)
      await vi.advanceTimersByTimeAsync(10)

      await rejection
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out an alive child before readiness only after it exits', async () => {
    vi.useFakeTimers()
    try {
      const { child, dependencies } = harness()
      const start = startHarness(dependencies)
      const error = rejectedError(start)

      await vi.advanceTimersByTimeAsync(10)
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.listenerCount('exit')).toBe(1)

      child.exit()
      const actual = await error
      expect(actual.name).toBe('HarnessStartupTimeoutError')
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('cleans startup listeners when a timed-out child does not exit after kill', async () => {
    vi.useFakeTimers()
    try {
      const { child, dependencies } = harness()
      const error = rejectedError(startHarness(dependencies))

      await vi.advanceTimersByTimeAsync(20)

      const actual = await error
      expect(actual).toBeInstanceOf(HarnessShutdownTimeoutError)
      expect(child.kill).toHaveBeenCalledTimes(1)
      expect(child.listenerCount('exit')).toBe(0)
      expect(child.stdout.listenerCount('data')).toBe(0)
      expect(child.stderr.listenerCount('data')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts startup, kills once, and wins races with late readiness and exit', async () => {
    const controller = new AbortController()
    const { child, dependencies } = harness()
    const start = startHarness(dependencies, { signal: controller.signal })
    const error = rejectedError(start)

    controller.abort()
    child.stdout.write('dsh web: http://127.0.0.1:4310\n')
    child.exit()

    const actual = await error
    expect(actual.name).toBe('AbortError')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
  })

  it('redacts inherited key and token values across stderr chunks', async () => {
    const apiKey = 'key-value-123'
    const token = 'token-value-456'
    const { child, dependencies } = harness({
      environment: { DEEPSEEK_API_KEY: apiKey, OTHER_TOKEN: token, FROM_PARENT: 'kept' },
    })
    const start = startHarness(dependencies)
    const error = rejectedError(start)

    child.stderr.write(`context ${apiKey.slice(0, 7)}`)
    child.stderr.write(`${apiKey.slice(7)} and ${token.slice(0, 6)}`)
    child.stderr.write(`${token.slice(6)} final diagnostic`)
    child.exit(23)

    const actual = await error
    expect(actual.message).toContain('context')
    expect(actual.message).toContain('final diagnostic')
    expect(actual.message).not.toContain(apiKey)
    expect(actual.message).not.toContain(apiKey.slice(0, 8))
    expect(actual.message).not.toContain(token)
    expect(actual.message).not.toContain(token.slice(0, 8))
  })

  it('keeps valid multibyte stderr text intact when chunks alternate between bytes and strings', async () => {
    const { child, dependencies } = harness()
    const start = startHarness(dependencies)
    const error = rejectedError(start)

    child.stderr.write(Buffer.from('界'))
    child.stderr.write('界'.repeat(3_000))
    child.stderr.write('final diagnostic')
    child.exit(24)

    const actual = await error
    expect(actual.message).toContain('final diagnostic')
    expect(actual.message).not.toContain('�')
  })
})
