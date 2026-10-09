/** Windows terminal lifecycle over an exactly owned ConPTY process and Job. */

import { PassThrough } from 'node:stream'
import { setTimeout as pause } from 'node:timers/promises'
import type { SubprocessOutcome, SubprocessTerminalHandle, SubprocessTerminalForeground, SubprocessTerminalInterruptResult, SubprocessTerminalSignal } from '@deepseek-ai/dsh-subprocess'
import type { WindowsPtyProcess } from './windows-pty.ts'

/** A Windows terminal with honest foreground limitations and awaited Job cleanup. */
export class WindowsTerminalHandle implements SubprocessTerminalHandle {
  readonly pid: number
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>
  private readonly outcome = Promise.withResolvers<SubprocessOutcome>()
  private readonly monitor: Promise<void>
  private readonly writes = new Set<Promise<void>>()
  private cleanup: Promise<void> | undefined
  /** Closing is irreversible even when a failed cleanup can be retried. */
  private closing = false

  /**
   * @param process - native process and transport resources, already assigned to their Job.
   * @param graceMs - caller's bound for observing Job termination.
   */
  constructor(private readonly process: WindowsPtyProcess, private readonly graceMs: number) {
    this.pid = process.pid
    this.done = this.outcome.promise
    process.output.on('data', this.onData)
    process.output.on('end', this.onEnd)
    process.output.on('error', this.onError)
    process.input.on('error', this.onError)
    this.monitor = this.observeExit()
  }

  private readonly onData = (data: Buffer): void => { this.output.write(data) }
  private readonly onEnd = (): void => { this.output.end() }
  private readonly onError = (error: Error): void => { this.outcome.reject(error) }

  async write(data: string): Promise<void> {
    if (this.closing || this.process.exitCode() !== undefined) return Promise.reject(new Error('terminal process has exited or is closing'))
    const write = new Promise<void>((resolve, reject) => {
      this.process.input.write(data, 'utf8', (error) => { if (error) reject(error); else resolve() })
    })
    this.writes.add(write)
    void write.finally(() => { this.writes.delete(write) }).catch(() => {})
    await write
  }

  async interrupt(): Promise<SubprocessTerminalInterruptResult> {
    await this.write('\x03')
    return { kind: 'control-input', input: 'ctrl-c' }
  }

  // ConPTY has no POSIX foreground process-group identity.
  // oxlint-disable-next-line typescript/require-await -- The provider interface preserves rejection semantics.
  async inspectForeground(): Promise<SubprocessTerminalForeground | undefined> { return undefined }

  // oxlint-disable-next-line typescript/require-await -- Unsupported signalling is an asynchronous provider rejection.
  async signalForeground(signal: SubprocessTerminalSignal): Promise<number> {
    throw new Error(`Windows ConPTY does not support POSIX foreground signal ${signal}; use terminal input or terminate the session`)
  }

  // Both native handles share this retryable cleanup protocol; closeOnce owns
  // platform-specific quiescence. Keep the protocol symmetric without a base class.
  /* jscpd:ignore-start */
  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    this.closing = true
    const cleanup = this.closeOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }
  /* jscpd:ignore-end */

  /** Force-stop the exactly owned Job during host exit; no asynchronous wait is possible. */
  terminateForHostExit(): void {
    this.closing = true
    this.process.closeForHostExit()
  }

  private async observeExit(): Promise<void> {
    try {
      let exitCode = this.process.exitCode()
      while (exitCode === undefined) {
        await pause(15)
        exitCode = this.process.exitCode()
      }
      this.outcome.resolve({ exitCode, signal: null })
    } catch (error) {
      this.outcome.reject(error)
    }
  }

  private async closeOnce(): Promise<void> {
    this.process.kill()
    const until = Date.now() + this.graceMs
    while (this.process.activeProcesses() !== 0 || this.process.exitCode() === undefined) {
      if (Date.now() >= until) throw new Error(`Windows terminal cleanup timed out for process ${this.pid}`)
      await pause(Math.min(15, Math.max(1, until - Date.now())))
    }
    await this.monitor
    try {
      await this.process.close()
    } finally {
      await Promise.allSettled([...this.writes])
      this.process.output.off('data', this.onData)
      this.process.output.off('end', this.onEnd)
      this.process.output.off('error', this.onError)
      this.process.input.off('error', this.onError)
      this.output.end()
    }
  }
}
