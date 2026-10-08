/** Real native cleanup with worker failure injected only after ConPTY has closed. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { childEnv } from '../src/spawn.ts'
import { createWindowsPty } from '../src/windows-pty.ts'

const fault = vi.hoisted(() => ({
  mode: 'none' as 'none' | 'error' | 'code' | 'held-error', releaseExit: undefined as (() => void) | undefined,
  failAssignment: false, rootPid: 0, rollbackWaits: 0, waitResult: undefined as number | undefined,
}))

vi.mock('koffi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('koffi')>()
  return {
    ...actual,
    default: {
      ...actual.default,
      load(...args: Parameters<typeof actual.load>) {
        const library = actual.default.load(...args)
        return new Proxy(library, {
          get(target, key): unknown {
            if (key !== 'func') return Reflect.get(target, key)
            return (definition: string) => {
              const native = target.func(definition)
              return Object.assign((...args: unknown[]): unknown => {
                if (fault.failAssignment && definition.includes('AssignProcessToJobObject(')) return 0
                if (fault.failAssignment && definition.includes('WaitForSingleObject(')) {
                  fault.rollbackWaits++
                  if (fault.waitResult !== undefined) return fault.waitResult
                }
                const result: unknown = native(...args)
                if (fault.failAssignment && definition.includes('CreateProcessW(') && result === 1) {
                  const info = args[9]
                  if (!Buffer.isBuffer(info)) throw new Error('CreateProcessW requires a process information buffer')
                  fault.rootPid = info.readUInt32LE(16)
                }
                return result
              }, native)
            }
          },
        })
      },
    },
  }
})

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  const { EventEmitter } = await import('node:events')
  return {
    ...actual,
    Worker: class extends EventEmitter {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super()
        const worker = new actual.Worker(...args)
        worker.once('error', (error) => { this.emit('error', error) })
        worker.once('exit', (code) => {
          if (code !== 0 || fault.mode === 'none') { this.emit('exit', code); return }
          const mode = fault.mode
          fault.mode = 'none'
          if (mode !== 'code') this.emit('error', new Error('injected close worker failure'))
          if (mode === 'held-error') fault.releaseExit = () => { this.emit('exit', 1) }
          else this.emit('exit', 1)
        })
      }
    },
  }
})

afterEach(() => {
  fault.releaseExit?.()
  fault.releaseExit = undefined
  fault.mode = 'none'
  fault.failAssignment = false
  fault.rootPid = 0
  fault.rollbackWaits = 0
  fault.waitResult = undefined
})

const spec = { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], cwd: process.cwd(), rows: 24, cols: 80, graceMs: 1000 }

describe.skipIf(process.platform !== 'win32')('Windows native cleanup failures', () => {
  it('joins a suspended root whose Job assignment failed before closing its process handle', async () => {
    fault.failAssignment = true
    await expect(createWindowsPty(spec, childEnv())).rejects.toThrow('AssignProcessToJobObject')
    expect(fault.rootPid).toBeGreaterThan(0)
    expect(fault.rollbackWaits).toBeGreaterThan(0)
    expect(() => { process.kill(fault.rootPid, 0) }).toThrow()
  })

  it.each([
    [258, 'rollback timed out'],
    [0xffffffff, 'WaitForSingleObject(rollback)'],
  ] as const)('does not claim rollback quiescence when native waiting returns %s', async (state, message) => {
    fault.failAssignment = true
    fault.waitResult = state
    const failure = await createWindowsPty({ ...spec, graceMs: 5 }, childEnv()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const error = failure as AggregateError
    expect(error.cause).toBe(error.errors[0])
    expect((error.errors[0] as Error).message).toContain('AssignProcessToJobObject')
    expect((error.errors[1] as Error).message).toContain(message)
    expect(() => { process.kill(fault.rootPid, 0) }).toThrow()
  })

  it('releases native handles and channels when final output fails', async () => {
    const native = await createWindowsPty(spec, childEnv())
    native.output.resume()
    try {
      native.kill()
      await vi.waitFor(() =>{  expect(native.exitCode()).toBe(1) })
      native.output.destroy(new Error('injected output failure'))
      await expect(native.close()).rejects.toThrow('injected output failure')
      expect(native.input.destroyed).toBe(true)
      expect(native.output.destroyed).toBe(true)
      expect(native.activeProcesses()).toBe(0)
      expect(native.exitCode()).toBe(1)
      expect(() =>{  native.kill() }).not.toThrow()
    } finally {
      native.kill()
      await native.close().catch(() => {})
    }
  })

  it.each(['held-error', 'code'] as const)('joins worker exit and releases resources after %s', async (mode) => {
    const native = await createWindowsPty(spec, childEnv())
    native.output.resume()
    try {
      native.kill()
      await vi.waitFor(() =>{  expect(native.exitCode()).toBe(1) })
      fault.mode = mode
      const closing = native.close()
      expect(native.close()).toBe(closing)
      let settled = false
      const failed = expect(closing.finally(() => { settled = true })).rejects.toThrow(mode === 'code' ? 'worker exited 1' : 'injected close worker failure')
      if (mode === 'held-error') {
        await vi.waitFor(() =>{  expect(fault.releaseExit).toBeTypeOf('function') })
        expect(settled).toBe(false)
        fault.releaseExit?.()
        fault.releaseExit = undefined
      }
      await failed
      expect(native.input.destroyed).toBe(true)
      expect(native.output.destroyed).toBe(true)
      expect(native.activeProcesses()).toBe(0)
      expect(native.exitCode()).toBe(1)
      expect(native.close()).toBe(closing)
    } finally {
      fault.releaseExit?.()
      fault.releaseExit = undefined
      native.kill()
      await native.close().catch(() => {})
    }
  })

  it('reports both allocation and rollback failures without discarding the original cause', async () => {
    fault.mode = 'error'
    const failure = await createWindowsPty({ ...spec, argv: ['Z:/missing-terminal-program.exe'] }, childEnv()).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    const error = failure as AggregateError
    expect(error.message).toBe('Windows terminal allocation and cleanup failed')
    expect(error.cause).toBe(error.errors[0])
    expect((error.errors[0] as Error).message).toContain('CreateProcessW')
    expect((error.errors[1] as Error).message).toBe('injected close worker failure')
  })
})
