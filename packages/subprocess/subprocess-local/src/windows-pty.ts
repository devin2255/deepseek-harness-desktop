/** Windows ConPTY allocation with suspended launch and kill-on-close Job ownership. */

import { randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { finished } from 'node:stream/promises'
import { setTimeout as pause } from 'node:timers/promises'
import koffi from 'koffi'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'

declare const nativeHandle: unique symbol
type Handle = bigint & { readonly [nativeHandle]: true }

/**
 * Failed native allocation whose rollback cannot prove complete resource release.
 * @param allocationError - original setup or cancellation failure.
 * @param cleanupErrors - failed native cleanup or termination observations.
 */
export class WindowsPtyAllocationCleanupError extends AggregateError {
  constructor(readonly allocationError: unknown, readonly cleanupErrors: readonly unknown[]) {
    super([allocationError, ...cleanupErrors], 'Windows terminal allocation and cleanup failed', { cause: allocationError })
  }
}

/** Native process and transport resources owned by one Windows terminal. */
export interface WindowsPtyProcess {
  /** Root process id, for display only; cleanup uses native handles. */
  readonly pid: number
  /** Host side of the ConPTY input channel. */
  readonly input: Socket
  /** Host side of the ConPTY output channel. */
  readonly output: Socket
  /** @returns the root exit code, or undefined while it is running. */
  exitCode(this: void): number | undefined
  /** @returns the number of processes still associated with the owned Job. */
  activeProcesses(this: void): number
  /** Force-terminate the owned Job without closing its query handle. */
  kill(this: void): void
  /** Release resources after Job quiescence; propagate close failures without repeating an uncertain ConPTY close. */
  close(this: void): Promise<void>
  /** Close the kill-on-close Job synchronously during host exit, without claiming quiescence. */
  closeForHostExit(this: void): void
}

interface Bindings {
  createFile(name: string, access: number, share: number, security: null, disposition: number, flags: number, template: null): Handle | null
  closeHandle(handle: Handle): number
  lastError(): number
  compareOrdinal(left: string, leftLength: number, right: string, rightLength: number, ignoreCase: number): number
  createConsole(size: number, input: Handle, output: Handle, flags: number, result: Buffer): number
  initializeAttributes(list: Handle | null, count: number, flags: number, size: Buffer): number
  updateAttribute(list: Handle, flags: number, attribute: number, value: Handle, size: number, previous: null, returned: null): number
  deleteAttributes(list: Handle): void
  createProcess(application: null, command: Buffer, processSecurity: null, threadSecurity: null,
    inherit: number, flags: number, environment: Buffer, cwd: string, startup: Buffer, result: Buffer): number
  resumeThread(thread: Handle): number
  terminateProcess(process: Handle, code: number): number
  wait(process: Handle, milliseconds: number): number
  exitCode(process: Handle, result: Buffer): number
  createJob(security: null, name: null): Handle | null
  setJob(job: Handle, informationClass: number, information: Buffer, bytes: number): number
  assignJob(job: Handle, process: Handle): number
  terminateJob(job: Handle, code: number): number
  queryJob(job: Handle, informationClass: number, information: Buffer, bytes: number, returned: null): number
}

let bindings: Bindings | undefined

function win32(): Bindings {
  if (bindings !== undefined) return bindings
  if (process.platform !== 'win32' || koffi.sizeof('void *') !== 8) {
    throw new Error('Windows terminal requires a 64-bit Windows ConPTY host')
  }
  const library = koffi.load('kernel32.dll')
  bindings = {
    createFile: library.func('void * __stdcall CreateFileW(str16, uint32, uint32, void *, uint32, uint32, void *)'),
    closeHandle: library.func('int __stdcall CloseHandle(void *)'),
    lastError: library.func('uint32 __stdcall GetLastError()'),
    compareOrdinal: library.func('int __stdcall CompareStringOrdinal(str16, int, str16, int, int)'),
    // COORD is a four-byte value, not a pointer to two shorts.
    createConsole: library.func('int32 __stdcall CreatePseudoConsole(uint32, void *, void *, uint32, void *)'),
    initializeAttributes: library.func('int __stdcall InitializeProcThreadAttributeList(void *, uint32, uint32, void *)'),
    updateAttribute: library.func('int __stdcall UpdateProcThreadAttribute(void *, uint32, uintptr_t, void *, uintptr_t, void *, void *)'),
    deleteAttributes: library.func('void __stdcall DeleteProcThreadAttributeList(void *)'),
    createProcess: library.func('int __stdcall CreateProcessW(void *, void *, void *, void *, int, uint32, void *, str16, void *, void *)'),
    resumeThread: library.func('uint32 __stdcall ResumeThread(void *)'),
    terminateProcess: library.func('int __stdcall TerminateProcess(void *, uint32)'),
    wait: library.func('uint32 __stdcall WaitForSingleObject(void *, uint32)'),
    exitCode: library.func('int __stdcall GetExitCodeProcess(void *, void *)'),
    createJob: library.func('void * __stdcall CreateJobObjectW(void *, void *)'),
    setJob: library.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32)'),
    assignJob: library.func('int __stdcall AssignProcessToJobObject(void *, void *)'),
    terminateJob: library.func('int __stdcall TerminateJobObject(void *, uint32)'),
    queryJob: library.func('int __stdcall QueryInformationJobObject(void *, int, void *, uint32, void *)'),
  }
  return bindings
}

function failure(api: Bindings, operation: string): Error {
  return new Error(`Windows terminal: ${operation} failed (Win32 ${api.lastError()})`)
}

function pointer(slot: Buffer, offset = 0): Handle {
  return slot.readBigUInt64LE(offset) as Handle
}

/**
 * Encode argv using the Windows CRT backslash and quote rules.
 * @param argv - complete executable and argument vector.
 * @returns a mutable, NUL-terminated UTF-16 command line for CreateProcessW.
 */
export function windowsTerminalCommand(argv: readonly string[]): Buffer {
  const quote = (argument: string): string => {
    if (argument.includes('\0')) throw new Error('Windows terminal argv must not contain NUL')
    if (argument !== '' && !/[\s"]/u.test(argument)) return argument
    return '"' + argument.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, '$1$1') + '"'
  }
  return Buffer.from(argv.map(quote).join(' ') + '\0', 'utf16le')
}

/**
 * Encode the caller's scrubbed environment using Windows ordinal name ordering.
 * @param environment - effective Windows environment; undefined entries are omitted.
 * @returns a sorted, double-NUL-terminated UTF-16 environment block.
 */
export function windowsTerminalEnvironment(environment: NodeJS.ProcessEnv): Buffer {
  const entries = Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined)
  for (const [key, value] of entries) {
    if (key.length === 0 || key.includes('\0') || key.includes('=') || value.includes('\0')) {
      throw new Error('Windows terminal environment contains an invalid name or NUL')
    }
  }
  entries.sort(([a], [b]) => {
    const api = win32()
    const order = api.compareOrdinal(a, -1, b, -1, 1)
    if (order === 0) throw failure(api, 'CompareStringOrdinal')
    return order - 2
  })
  return Buffer.from(entries.map(([key, value]) => `${key}=${value}`).join('\0') + '\0\0', 'utf16le')
}

async function pipe(api: Bindings, access: number, signal: AbortSignal | undefined): Promise<{ socket: Socket; native: Handle }> {
  const server = createServer({ allowHalfOpen: true })
  const connected = Promise.withResolvers<Socket>()
  // A rejected connection is observed even when native opening fails first.
  void connected.promise.catch(() => {})
  const path = `\\\\.\\pipe\\dsh-terminal-${randomUUID()}`
  const onAbort = (): void => { connected.reject(signal?.reason) }
  signal?.addEventListener('abort', onAbort, { once: true })
  server.once('error', connected.reject)
  server.once('connection', connected.resolve)
  let native: Handle | null = null
  try {
    signal?.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, resolve)
    })
    signal?.throwIfAborted()
    native = api.createFile(path, access, 0, null, 3, 0, null)
    if (native === null || native === 0n || native === 0xffffffffffffffffn) throw failure(api, 'CreateFileW(pipe)')
    const socket = await connected.promise
    // Error events are forwarded by the published handle; allocation also owns
    // errors until those listeners are installed.
    socket.on('error', () => {})
    signal?.throwIfAborted()
    return { socket, native }
  } catch (error) {
    if (native !== null && native !== 0n && native !== 0xffffffffffffffffn) api.closeHandle(native)
    void connected.promise.then(socket => socket.destroy(), () => {})
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
    server.close()
  }
}

/**
 * Allocate ConPTY and start the requested process only after Job assignment.
 * @param spec - explicit terminal allocation and cancellation inputs.
 * @param environment - effective scrubbed environment supplied by the local provider.
 * @returns owned native resources; no user code runs outside their Job.
 */
export async function createWindowsPty(spec: SubprocessTerminalSpawnSpec, environment: NodeJS.ProcessEnv): Promise<WindowsPtyProcess> {
  const api = win32()
  const command = windowsTerminalCommand(spec.argv)
  const environmentBlock = windowsTerminalEnvironment(environment)
  if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`Windows terminal graceMs must be positive and no greater than ${MAX_TIMER_DELAY_MS}`)
  }
  if (![spec.cols, spec.rows].every(value => Number.isInteger(value) && value > 0 && value <= 32767)) {
    throw new Error('Windows terminal dimensions must be integers from 1 to 32767')
  }
  spec.signal?.throwIfAborted()
  const input = await pipe(api, 0x80000000, spec.signal)
  let output: Awaited<ReturnType<typeof pipe>> | undefined
  let console: Handle | undefined
  let job: Handle | undefined
  let processHandle: Handle | undefined
  let thread: Handle | undefined
  let attributes: Handle | undefined
  let attributesInitialized = false
  try {
    output = await pipe(api, 0x40000000, spec.signal)
    const consoleSlot = Buffer.alloc(8)
    const result = api.createConsole((spec.rows << 16) | spec.cols, input.native, output.native, 0, consoleSlot)
    if (result < 0) throw new Error(`Windows terminal: CreatePseudoConsole failed (HRESULT ${result >>> 0})`)
    console = pointer(consoleSlot)
    const createdJob = api.createJob(null, null)
    if (createdJob === null || createdJob === 0n) throw failure(api, 'CreateJobObjectW')
    job = createdJob
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION, x64/arm64 Windows ABI.
    const limits = Buffer.alloc(144)
    limits.writeUInt32LE(0x2000, 16) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway flags.
    if (api.setJob(job, 9, limits, limits.length) === 0) throw failure(api, 'SetInformationJobObject')
    const size = Buffer.alloc(8)
    api.initializeAttributes(null, 1, 0, size)
    attributes = koffi.alloc('uint8_t', Number(size.readBigUInt64LE())) as Handle
    if (api.initializeAttributes(attributes, 1, 0, size) === 0) throw failure(api, 'InitializeProcThreadAttributeList')
    attributesInitialized = true
    if (api.updateAttribute(attributes, 0, 0x20016, console, 8, null, null) === 0) throw failure(api, 'UpdateProcThreadAttribute')
    const startup = Buffer.alloc(112) // STARTUPINFOEXW.
    startup.writeUInt32LE(startup.length)
    // Do not inherit the host's console standard handles into the new ConPTY.
    startup.writeUInt32LE(0x100, 60) // STARTF_USESTDHANDLES, with all three handles NULL.
    startup.writeBigUInt64LE(attributes, 104)
    const info = Buffer.alloc(24) // PROCESS_INFORMATION.
    // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED.
    if (api.createProcess(null, command, null, null, 0, 0x80404, environmentBlock, spec.cwd, startup, info) === 0) {
      throw failure(api, 'CreateProcessW')
    }
    processHandle = pointer(info)
    thread = pointer(info, 8)
    if (api.assignJob(job, processHandle) === 0) throw failure(api, 'AssignProcessToJobObject')
    spec.signal?.throwIfAborted()
    if (api.resumeThread(thread) === 0xffffffff) throw failure(api, 'ResumeThread')
    api.closeHandle(thread)
    thread = undefined
    return ownedProcess(api, info.readUInt32LE(16), processHandle, job, console, input.socket, output.socket)
  } catch (error) {
    // A suspended process whose Job assignment failed still needs exact-handle
    // termination. Closing its process handle alone would orphan it.
    const cleanupErrors: unknown[] = []
    try {
      if (processHandle !== undefined) await stopUnpublishedRoot(api, processHandle, spec.graceMs)
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    } finally {
      if (job !== undefined) api.closeHandle(job)
      if (processHandle !== undefined) api.closeHandle(processHandle)
      if (thread !== undefined) api.closeHandle(thread)
    }
    output?.socket.resume()
    try {
      if (console !== undefined) await closeConsole(console)
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    } finally {
      input.socket.destroy()
      output?.socket.destroy()
    }
    if (cleanupErrors.length > 0) {
      throw new WindowsPtyAllocationCleanupError(error, cleanupErrors)
    }
    throw error
  } finally {
    api.closeHandle(input.native)
    if (output !== undefined) api.closeHandle(output.native)
    if (attributes !== undefined) {
      if (attributesInitialized) api.deleteAttributes(attributes)
      koffi.free(attributes)
    }
  }
}

async function stopUnpublishedRoot(api: Bindings, process: Handle, graceMs: number): Promise<void> {
  const terminationError = api.terminateProcess(process, 1) === 0 ? failure(api, 'TerminateProcess') : undefined
  const until = Date.now() + graceMs
  for (;;) {
    const state = api.wait(process, 0)
    if (state === 0) return
    if (terminationError !== undefined) throw terminationError
    if (state !== 258) throw failure(api, 'WaitForSingleObject(rollback)')
    if (Date.now() >= until) throw new Error('Windows terminal root rollback timed out')
    await pause(Math.min(15, Math.max(1, until - Date.now())))
  }
}

function closeConsole(console: Handle): Promise<void> {
  // Closing ConPTY can emit a final frame; draining its output must remain on
  // the event loop. Koffi's asynchronous call path faults on ClosePseudoConsole;
  // a dedicated Node worker runs the synchronous binding instead.
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads')
    const koffi = require(workerData.koffi)
    const library = koffi.load('kernel32.dll')
    library.func('void __stdcall ClosePseudoConsole(void *)')(workerData.handle)
  `, { eval: true, execArgv: [], workerData: { koffi: createRequire(import.meta.url).resolve('koffi'), handle: console } })
  return new Promise((resolve, reject) => {
    let failure: Error | undefined
    worker.once('error', (error) => { failure = error })
    worker.once('exit', (code) => {
      if (failure !== undefined) reject(failure)
      else if (code === 0) resolve()
      else reject(new Error(`ConPTY close worker exited ${code}`))
    })
  })
}

function ownedProcess(api: Bindings, pid: number, process: Handle, job: Handle,
  console: Handle, input: Socket, output: Socket): WindowsPtyProcess {
  let handlesClosed = false
  let observedExitCode: number | undefined
  let closing: Promise<void> | undefined
  const closeHandles = (): void => {
    if (handlesClosed) return
    api.closeHandle(job)
    api.closeHandle(process)
    handlesClosed = true
  }
  return {
    pid, input, output,
    exitCode() {
      if (observedExitCode !== undefined) return observedExitCode
      if (handlesClosed) throw new Error('Windows terminal native handles are closed')
      const state = api.wait(process, 0)
      if (state === 258) return undefined
      if (state !== 0) throw failure(api, 'WaitForSingleObject')
      const code = Buffer.alloc(4)
      if (api.exitCode(process, code) === 0) throw failure(api, 'GetExitCodeProcess')
      observedExitCode = code.readUInt32LE()
      return observedExitCode
    },
    activeProcesses() {
      if (handlesClosed) return 0
      const accounting = Buffer.alloc(48)
      if (api.queryJob(job, 1, accounting, accounting.length, null) === 0) throw failure(api, 'QueryInformationJobObject')
      return accounting.readUInt32LE(40)
    },
    kill() {
      if (!handlesClosed && api.terminateJob(job, 1) === 0) throw failure(api, 'TerminateJobObject')
    },
    close() {
      if (closing !== undefined) return closing
      closing = (async () => {
        const ended = finished(output, { readable: true, writable: false, cleanup: true })
        // Observe transport rejection while the close worker still owns ConPTY.
        void ended.catch(() => {})
        try {
          await closeConsole(console)
          input.destroy()
          await ended
        } finally {
          input.destroy()
          output.destroy()
          closeHandles()
        }
      })()
      return closing
    },
    closeForHostExit() {
      closeHandles()
    },
  }
}
