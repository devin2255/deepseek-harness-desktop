/** Starts and stops the desktop-scoped DeepSeek Harness utility process after Electron is ready. */

import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { utilityProcess, type ForkOptions } from 'electron'
import { createReadinessParser } from './readiness.ts'
import { RedactedStderrTail } from './sensitive-text-redactor.ts'

const CAPABILITY_BYTES = 32
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
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
 * The entry must be the trusted packaged Harness CLI: its utility child alone receives
 * the Node-internals flag required by the Loader fallback and must not run untrusted code.
 * Rejects for an early child exit, startup timeout, caller abort, or shutdown timeout.
 * @param overrides - Optional production dependencies replaced by focused tests. Fork errors propagate to the caller.
 * @param options - Caller cancellation accepted until readiness; timeout and cancellation kill the child and wait for exit.
 * @returns The ready loopback endpoint and an idempotent asynchronous shutdown handle.
 */
export function startHarness(
  overrides: Partial<HarnessSupervisorDependencies> = {},
  options: HarnessStartOptions = {},
): Promise<HarnessHandle> {
  if (isSignalAborted(options.signal)) return Promise.reject(new HarnessStartupAbortedError())
  const dependencies = resolveDependencies(overrides)
  const capability = dependencies.randomBytes(CAPABILITY_BYTES).toString('base64url')
  const child = dependencies.fork(dependencies.resolveCli(), ['--profile', 'desktop', '--port', '0'], {
    cwd: dependencies.cwd(),
    env: { ...dependencies.environment, DSH_DESKTOP_CAPABILITY: capability },
    // Electron's ABI cannot load the host-Node `node-addon-require-builtin` binary used by
    // `@deepseek-ai/loader` for `ModuleLoader.fromInternal()`. Scope the pure Node-internals
    // fallback to this trusted Harness utility child instead of exposing it to other children.
    execArgv: ['--expose-internals'],
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
    startupShutdownTimer = setTimeout(() => {
      child.off('exit', onStartupExit)
      failStartup(new HarnessShutdownTimeoutError(dependencies.shutdownTimeoutMs))
    }, dependencies.shutdownTimeoutMs)
    startupShutdownTimer.unref()
    requestKill()
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
  if (isSignalAborted(options.signal)) onAbort()

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

/** Read cancellation state through a call so the abort event race remains observable after startup setup. */
function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
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

/** Return the capability and inherited sensitive environment values for diagnostic redaction. */
function redactionPatterns(capability: string, environment: NodeJS.ProcessEnv): string[] {
  const patterns = [capability]
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && value.length > 0 && SENSITIVE_ENVIRONMENT_KEY.test(key)) patterns.push(value)
  }
  return [...new Set(patterns)]
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
    requestKill()
  })
}
