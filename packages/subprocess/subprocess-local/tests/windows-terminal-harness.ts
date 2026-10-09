/** Controlled native resources for portable Windows lifecycle tests. */
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'
import type { Socket } from 'node:net'
import { vi } from 'vitest'
import type { WindowsPtyProcess } from '../src/windows-pty.ts'

/** @returns controllable root/Job state and transport channels. */
export function nativeProcess() {
  const input = new PassThrough()
  const output = new PassThrough()
  input.resume()
  let code: number | undefined
  let members = 1
  const native: WindowsPtyProcess = {
    pid: 42, input: input as unknown as Socket, output: output as unknown as Socket,
    exitCode: vi.fn(() => code), activeProcesses: vi.fn(() => members),
    kill: vi.fn(() => { code = 1; members = 0 }),
    close: vi.fn(() => { input.destroy(); output.end(); return finished(output, { readable: true, writable: false, cleanup: true }) }),
    closeForHostExit: vi.fn(() => { code = 1; members = 0 }),
  }
  return { native, input, output, exit: (value: number) => { code = value }, members: (value: number) => { members = value } }
}
