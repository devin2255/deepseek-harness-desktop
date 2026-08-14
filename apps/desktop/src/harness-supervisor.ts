/** Starts and stops the desktop-scoped DeepSeek Harness utility process after Electron is ready. */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { utilityProcess, type ForkOptions } from 'electron'
import { createReadinessParser } from './readiness.ts'

const CAPABILITY_BYTES = 32
/** Maximum retained stderr diagnostic suffix; decoded invalid UTF-8 uses deterministic replacement characters. */
const STDERR_TAIL_BYTES = 8 * 1024
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const REDACTION = '[redacted]'
const SENSITIVE_ENVIRONMENT_KEY = /KEY|SECRET|TOKEN|PASSWORD/iu
const dshRequire = createRequire(import.meta.url)

/** A process output stream used for the readiness signal and diagnostics. */
export interface HarnessOutput {
  /** Subscribe to output chunks. */
  on(event: 'data', listener: (chunk: unknown) => void): this
  /** Remove an output listener. */
  off(event: 'data', listener: (chunk: unknown) => void): this
}

/** The subset of Electron's utility process API owned by the supervisor. */
export interface HarnessUtilityProcess {
  /** Standard output when the process was forked with piped stdio. */
  readonly stdout: HarnessOutput | null
  /** Standard error when the process was forked with piped stdio. */
  readonly stderr: HarnessOutput | null
  /** Subscribe to process completion. */
  on(event: 'exit', listener: (code: number) => void): this
  /** Remove a process-completion listener. */
  off(event: 'exit', listener: (code: number) => void): this
  /** Request utility-process termination. */
  kill(): boolean
}

/** Launch inputs that can be replaced in tests without creating an Electron process. */
export interface HarnessSupervisorDependencies {
  /** Forks the desktop Harness process. Call only after Electron app readiness. */
  fork(entry: string, args: string[], options: ForkOptions): HarnessUtilityProcess
  /** Resolves the installed Harness CLI entry. */
  resolveCli(): string
  /** Generates the per-process capability. */
  randomBytes(size: number): Buffer
  /** Returns the working directory for the child process. */
  cwd(): string
  /** Parent environment copied before the capability is added. */
  environment: NodeJS.ProcessEnv
  /** Maximum time to wait for an exit event after requesting termination. */
  shutdownTimeoutMs: number
  /** Maximum time to wait for the canonical readiness line. */
  startupTimeoutMs: number
}

/** Optional caller-owned startup cancellation. */
export interface HarnessStartOptions {
  /** Cancels startup before the Harness announces readiness. */
  readonly signal?: AbortSignal
}

/** A ready desktop Harness endpoint and its private capability. */
export interface HarnessHandle {
  /** Loopback URL announced by the child process. */
  readonly endpoint: URL
  /** Per-process bearer capability; callers must not log or serialize it. */
  readonly capability: string
  /** Request shutdown and wait for exit; rejects on timeout while the process may remain alive. */
  stop(): Promise<void>
}

/** Reports that a utility process did not exit before the shutdown deadline. */
export class HarnessShutdownTimeoutError extends Error {
  /**
   * @param timeoutMs - The elapsed shutdown deadline.
   */
  constructor(timeoutMs: number) {
    super(`Harness utility process did not exit within ${timeoutMs}ms`)
    this.name = 'HarnessShutdownTimeoutError'
  }
}

/** Reports that the child did not announce readiness before the startup deadline. */
export class HarnessStartupTimeoutError extends Error {
  /**
   * @param timeoutMs - The elapsed readiness deadline.
   */
  constructor(timeoutMs: number) {
    super(`Harness utility process did not announce readiness within ${timeoutMs}ms`)
    this.name = 'HarnessStartupTimeoutError'
  }
}

/** Reports caller cancellation before the child announced readiness. */
export class HarnessStartupAbortedError extends Error {
  constructor() {
    super('Harness startup was aborted')
    this.name = 'AbortError'
  }
}

/**
 * Fork the desktop profile and wait for its canonical loopback readiness line.
 * The caller must invoke this only after Electron's `app.whenReady()` resolves,
 * because Electron permits `utilityProcess.fork()` only after app readiness.
 * Rejects for an early child exit, startup timeout, caller abort, or shutdown timeout.
 * @param overrides - Optional production dependencies replaced by focused tests. Fork errors propagate to the caller.
 * @param options - Caller cancellation accepted until readiness; timeout and cancellation kill the child and wait for exit.
 * @returns The ready loopback endpoint and an idempotent asynchronous shutdown handle.
 */
export function startHarness(
  overrides: Partial<HarnessSupervisorDependencies> = {},
  options: HarnessStartOptions = {},
): Promise<HarnessHandle> {
  const dependencies = resolveDependencies(overrides)
  const capability = dependencies.randomBytes(CAPABILITY_BYTES).toString('base64url')
  const child = dependencies.fork(dependencies.resolveCli(), ['--profile', 'desktop', '--port', '0'], {
    cwd: dependencies.cwd(),
    env: { ...dependencies.environment, DSH_DESKTOP_CAPABILITY: capability },
    serviceName: 'DeepSeek Harness Runtime',
    stdio: 'pipe',
  })

  let exited = false
  let resolveExit: (() => void) | undefined
  const exitedPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })
  let stopPromise: Promise<void> | undefined
  let completeStartup: ((handle: HarnessHandle) => void) | undefined
  let rejectStartup: ((reason: Error) => void) | undefined
  let startupSettled = false
  let startupFailure: Error | undefined
  let startupShutdownTimer: ReturnType<typeof setTimeout> | undefined
  let killRequested = false
  const stderrTail = new RedactedStderrTail(redactionPatterns(capability, dependencies.environment))
  const startupPromise = new Promise((resolve: (handle: HarnessHandle) => void, reject: (reason: Error) => void) => {
    completeStartup = resolve
    rejectStartup = reject
  })

  const removeOutputListeners = (): void => {
    if (child.stdout !== null) child.stdout.off('data', onStdout)
    if (child.stderr !== null) child.stderr.off('data', onStderr)
  }

  const clearStartupControls = (): void => {
    clearTimeout(startupTimer)
    if (startupShutdownTimer !== undefined) clearTimeout(startupShutdownTimer)
    options.signal?.removeEventListener('abort', onAbort)
  }

  const requestKill = (): void => {
    if (killRequested) return
    killRequested = true
    child.kill()
  }

  const finishStartup = (handle: HarnessHandle): void => {
    if (startupSettled || startupFailure !== undefined) return
    startupSettled = true
    clearStartupControls()
    removeOutputListeners()
    child.off('exit', onStartupExit)
    child.on('exit', onRuntimeExit)
    completeStartup?.(handle)
  }

  const failStartup = (error: Error): void => {
    if (startupSettled) return
    startupSettled = true
    clearStartupControls()
    removeOutputListeners()
    child.off('exit', onStartupExit)
    rejectStartup?.(error)
  }

  const beginStartupFailure = (error: Error): void => {
    if (startupSettled || startupFailure !== undefined) return
    startupFailure = error
    clearTimeout(startupTimer)
    options.signal?.removeEventListener('abort', onAbort)
    removeOutputListeners()
    requestKill()
    startupShutdownTimer = setTimeout(() => {
      child.off('exit', onStartupExit)
      failStartup(new HarnessShutdownTimeoutError(dependencies.shutdownTimeoutMs))
    }, dependencies.shutdownTimeoutMs)
    startupShutdownTimer.unref()
  }

  const onStartupExit = (code: number): void => {
    exited = true
    child.off('exit', onStartupExit)
    resolveExit?.()
    if (startupFailure !== undefined) {
      failStartup(startupFailure)
      return
    }
    const diagnostic = stderrTail.finish()
    const tail = diagnostic.length === 0 ? '' : `\nstderr tail:\n${diagnostic}`
    failStartup(new Error(`Harness exited before readiness (exit code ${code})${tail}`))
  }

  const onRuntimeExit = (): void => {
    exited = true
    child.off('exit', onRuntimeExit)
    resolveExit?.()
  }

  const stop = (): Promise<void> => {
    stopPromise ??= stopChild(
      exitedPromise,
      () => exited,
      removeOutputListeners,
      () => child.off('exit', onRuntimeExit),
      requestKill,
      dependencies.shutdownTimeoutMs,
    )
    return stopPromise
  }

  const parser = createReadinessParser((url) => {
    finishStartup({ endpoint: new URL(url), capability, stop })
  })
  const stdoutDecoder = new TextDecoder()
  const onStdout = (chunk: unknown): void => {
    parser.write(decodeOutput(stdoutDecoder, chunk))
  }
  const onStderr = (chunk: unknown): void => {
    stderrTail.write(chunk)
  }
  const onAbort = (): void => {
    beginStartupFailure(new HarnessStartupAbortedError())
  }

  child.on('exit', onStartupExit)
  if (child.stdout !== null) child.stdout.on('data', onStdout)
  if (child.stderr !== null) child.stderr.on('data', onStderr)
  const startupTimer = setTimeout(() => {
    beginStartupFailure(new HarnessStartupTimeoutError(dependencies.startupTimeoutMs))
  }, dependencies.startupTimeoutMs)
  startupTimer.unref()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted === true) onAbort()

  return startupPromise
}

/** Resolve default production inputs at the supervisor's explicit API boundary. */
function resolveDependencies(overrides: Partial<HarnessSupervisorDependencies>): HarnessSupervisorDependencies {
  return {
    fork: (entry, args, options) => utilityProcess.fork(entry, args, options),
    resolveCli: () => dshRequire.resolve('@deepseek-ai/dsh/lib/bin.js'),
    randomBytes: nodeRandomBytes,
    cwd: () => process.cwd(),
    environment: process.env,
    shutdownTimeoutMs: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    ...overrides,
  }
}

/** Decode a stdout chunk without corrupting UTF-8 text split across byte chunks. */
function decodeOutput(decoder: TextDecoder, chunk: unknown): string {
  return decoder.decode(outputBytes(chunk), { stream: true })
}

/** Convert an output chunk to bytes without inspecting or logging its contents. */
function outputBytes(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
}

/** Retains a redacted, UTF-8-safe stderr tail without preserving capability fragments. */
class RedactedStderrTail {
  readonly #decoder = new TextDecoder()
  #pending = ''
  #tail: Buffer = Buffer.alloc(0)

  /**
   * @param patterns - Non-empty sensitive values removed before data enters the retained tail.
   */
  constructor(private readonly patterns: readonly string[]) {}

  /** Consume one stderr chunk, keeping a bounded suffix that cannot contain the capability. */
  write(chunk: unknown): void {
    this.#writeText(this.#decoder.decode(outputBytes(chunk), { stream: true }))
  }

  /** Flush the decoder and return the diagnostic after scanning the final bounded remainder. */
  finish(): string {
    this.#writeText(this.#decoder.decode())
    const candidateLength = trailingSensitivePrefixLength(this.#pending, this.patterns)
    this.#tail = appendUtf8Tail(this.#tail, this.#pending.slice(0, this.#pending.length - candidateLength))
    if (candidateLength > 0) this.#tail = appendUtf8Tail(this.#tail, REDACTION)
    this.#pending = ''
    return new TextDecoder().decode(this.#tail)
  }

  /** Scan exact matches while retaining only a proper sensitive-value prefix between chunks. */
  #writeText(text: string): void {
    const combined = `${this.#pending}${text}`
    let index = 0
    let emitted = ''
    while (index < combined.length) {
      const remainder = combined.slice(index)
      if (this.patterns.some(pattern => pattern.length > remainder.length && pattern.startsWith(remainder))) break
      const matched = this.patterns.find(pattern => combined.startsWith(pattern, index))
      if (matched !== undefined) {
        emitted += REDACTION
        index += matched.length
      } else {
        const codePoint = combined.codePointAt(index)
        const width = codePoint === undefined || codePoint <= 0xffff ? 1 : 2
        emitted += combined.slice(index, index + width)
        index += width
      }
    }
    this.#pending = combined.slice(index)
    this.#tail = appendUtf8Tail(this.#tail, emitted)
  }
}

/** Return the longest non-empty suffix that is a prefix of any sensitive value at stderr EOF. */
function trailingSensitivePrefixLength(value: string, patterns: readonly string[]): number {
  let longest = 0
  for (const pattern of patterns) {
    const maximum = Math.min(pattern.length - 1, value.length)
    for (let length = maximum; length > longest; length -= 1) {
      if (value.endsWith(pattern.slice(0, length))) {
        longest = length
        break
      }
    }
  }
  return longest
}

/** Return the capability and inherited sensitive environment values, sorted for longest-match scanning. */
function redactionPatterns(capability: string, environment: NodeJS.ProcessEnv): string[] {
  const patterns = [capability]
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && value.length > 0 && SENSITIVE_ENVIRONMENT_KEY.test(key)) patterns.push(value)
  }
  return [...new Set(patterns)].sort((left, right) => right.length - left.length)
}

/** Append valid UTF-8 text and trim its leading bytes only at a Unicode code-point boundary. */
function appendUtf8Tail(current: Buffer, text: string): Buffer {
  const combined = Buffer.concat([current, Buffer.from(text)])
  if (combined.byteLength <= STDERR_TAIL_BYTES) return combined
  let start = combined.byteLength - STDERR_TAIL_BYTES
  while (start < combined.byteLength && isUtf8ContinuationByte(combined[start])) start += 1
  return combined.subarray(start)
}

/** Identify a byte that continues the preceding UTF-8 code point. */
function isUtf8ContinuationByte(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0b1100_0000) === 0b1000_0000
}

/** Request process termination once and reject if its exit event does not arrive on time. */
function stopChild(
  exitedPromise: Promise<void>,
  hasExited: () => boolean,
  removeOutputListeners: () => void,
  detachExitListener: () => void,
  requestKill: () => void,
  timeoutMs: number,
): Promise<void> {
  removeOutputListeners()
  if (hasExited()) return Promise.resolve()
  requestKill()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearTimeout(timer)
      detachExitListener()
      reject(new HarnessShutdownTimeoutError(timeoutMs))
    }, timeoutMs)
    timer.unref()
    void exitedPromise.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
