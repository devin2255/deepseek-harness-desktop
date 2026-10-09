import { afterEach, expect, it, vi } from 'vitest'
import { WindowsTerminalHandle } from '../src/windows-terminal.ts'
import { nativeProcess } from './windows-terminal-harness.ts'

afterEach(() => { vi.useRealTimers() })

it('reports Ctrl+C input only after its transport callback, without claiming process exit', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  let callback: (() => void) | undefined
  const write = vi.spyOn(process.input, 'write').mockImplementation((...args: unknown[]) => {
    expect(args[0]).toBe('\x03')
    callback = args[2] as () => void
    return true
  })
  let accepted = false
  const interrupt = terminal.interrupt().then((result) => { accepted = true; return result })
  await Promise.resolve()
  expect(accepted).toBe(false)
  callback?.()
  await expect(interrupt).resolves.toEqual({ kind: 'control-input', input: 'ctrl-c' })
  expect(process.native.exitCode()).toBeUndefined()
  expect(process.native.kill).not.toHaveBeenCalled()
  write.mockRestore()
  await terminal.terminate()
})

it('rejects interrupted-input failures and new interrupts after cleanup begins', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  const write = vi.spyOn(process.input, 'write').mockImplementation((...args: unknown[]) => {
    queueMicrotask(() => { (args[2] as (error: Error) => void)(new Error('interrupt write failed')) })
    return true
  })
  await expect(terminal.interrupt()).rejects.toThrow('interrupt write failed')
  write.mockRestore()
  const closing = terminal.terminate()
  await expect(terminal.interrupt()).rejects.toThrow('closing')
  await closing
})

it('bridges UTF-8 bytes, writes input, and preserves full-width Windows exit codes', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  let output = ''
  terminal.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
  process.output.write('中文\r\n')
  await terminal.write('input\r')
  expect(output).toBe('中文\r\n')
  process.exit(0xc0000142)
  await expect(terminal.done).resolves.toEqual({ exitCode: 0xc0000142, signal: null })
  await terminal.terminate()
  expect(terminal.output.readableEnded).toBe(true)
  expect(process.output.listenerCount('data')).toBe(0)
  expect(process.input.listenerCount('error')).toBe(0)
})

it('does not fabricate a POSIX group or translate its signals into keyboard bytes', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  await expect(terminal.inspectForeground()).resolves.toBeUndefined()
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGTSTP', 'SIGHUP'] as const) {
    await expect(terminal.signalForeground(signal)).rejects.toThrow(`signal ${signal}`)
  }
  await terminal.terminate()
})

it('shares concurrent termination and forbids new input as soon as cleanup starts', async () => {
  vi.useFakeTimers()
  const process = nativeProcess()
  vi.mocked(process.native.kill).mockImplementation(() => {})
  const terminal = new WindowsTerminalHandle(process.native, 100)
  const first = terminal.terminate()
  expect(terminal.terminate()).toBe(first)
  await expect(terminal.write('late')).rejects.toThrow('closing')
  await vi.advanceTimersByTimeAsync(20)
  process.exit(1)
  process.members(0)
  await vi.advanceTimersByTimeAsync(20)
  await first
  expect(process.native.kill).toHaveBeenCalledOnce()
  expect(process.native.close).toHaveBeenCalledOnce()
  expect(terminal.terminate()).toBe(first)
})

it('retains a failed cleanup for retry without reopening writes', async () => {
  const process = nativeProcess()
  vi.mocked(process.native.kill).mockImplementationOnce(() => { throw new Error('job kill failed') })
  const terminal = new WindowsTerminalHandle(process.native, 100)
  await expect(terminal.terminate()).rejects.toThrow('job kill failed')
  await expect(terminal.write('late')).rejects.toThrow('closing')
  await terminal.terminate()
  expect(process.native.kill).toHaveBeenCalledTimes(2)
})

it('does not accept root exit while its Job still has a live descendant', async () => {
  vi.useFakeTimers()
  const process = nativeProcess()
  process.exit(0)
  vi.mocked(process.native.kill).mockImplementation(() => {})
  const terminal = new WindowsTerminalHandle(process.native, 20)
  const failed = expect(terminal.terminate()).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(20)
  await failed
  expect(process.native.close).not.toHaveBeenCalled()
  process.members(0)
  await terminal.terminate()
})

it('waits for the root even if Job accounting already reports zero', async () => {
  vi.useFakeTimers()
  const process = nativeProcess()
  process.members(0)
  vi.mocked(process.native.kill).mockImplementation(() => {})
  const terminal = new WindowsTerminalHandle(process.native, 20)
  const failed = expect(terminal.terminate()).rejects.toThrow('timed out')
  await vi.advanceTimersByTimeAsync(20)
  await failed
  process.exit(1)
  const retry = terminal.terminate()
  await vi.advanceTimersByTimeAsync(15)
  await retry
})

it('reports transport and native-inspection failures without abandoning cleanup', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  const outcome = expect(terminal.done).rejects.toThrow('transport failed')
  process.output.emit('error', new Error('transport failed'))
  await outcome
  await terminal.terminate()

  const failedProcess = nativeProcess()
  vi.mocked(failedProcess.native.exitCode).mockImplementationOnce(() => { throw new Error('inspection failed') })
  const failedTerminal = new WindowsTerminalHandle(failedProcess.native, 100)
  await expect(failedTerminal.done).rejects.toThrow('inspection failed')
  await failedTerminal.terminate()
})

it('rejects writes after a natural exit and exposes only synchronous Job release at host exit', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  process.exit(0)
  await expect(terminal.write('late')).rejects.toThrow('exited')
  terminal.terminateForHostExit()
  expect(process.native.closeForHostExit).toHaveBeenCalledOnce()
  expect(process.native.close).not.toHaveBeenCalled()
  await terminal.done
  await terminal.terminate()
})

it('propagates asynchronous write failures and joins writes before cleanup settles', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  const write = vi.spyOn(process.input, 'write').mockImplementation((...args: unknown[]) => {
    const callback = args[2] as (error: Error) => void
    queueMicrotask(() => { callback(new Error('write failed')) })
    return true
  })
  await expect(terminal.write('input')).rejects.toThrow('write failed')
  await terminal.terminate()
  write.mockRestore()
})

it('does not settle cleanup until every outstanding input callback has completed', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  let callback: (() => void) | undefined
  vi.spyOn(process.input, 'write').mockImplementation((...args: unknown[]) => {
    callback = args[2] as () => void
    return true
  })
  const writing = terminal.write('pending')
  let settled = false
  const closing = terminal.terminate().then(() => { settled = true })
  await vi.waitFor(() => { expect(process.native.close).toHaveBeenCalledOnce() })
  expect(settled).toBe(false)
  callback?.()
  await writing
  await closing
  expect(settled).toBe(true)
})

it('joins pending writes and releases listeners even when native resource close fails', async () => {
  const process = nativeProcess()
  const terminal = new WindowsTerminalHandle(process.native, 100)
  terminal.output.resume()
  vi.mocked(process.native.close).mockRejectedValue(new Error('native close failed'))
  let callback: (() => void) | undefined
  vi.spyOn(process.input, 'write').mockImplementation((...args: unknown[]) => {
    callback = args[2] as () => void
    return true
  })
  const writing = terminal.write('pending')
  let settled = false
  const closing = terminal.terminate().finally(() => { settled = true })
  const failed = expect(closing).rejects.toThrow('native close failed')
  await vi.waitFor(() => { expect(process.native.close).toHaveBeenCalledOnce() })
  expect(settled).toBe(false)
  callback?.()
  await writing
  await failed
  await vi.waitFor(() => { expect(terminal.output.readableEnded).toBe(true) })
  expect(process.output.listenerCount('data')).toBe(0)
  expect(process.input.listenerCount('error')).toBe(0)
})
