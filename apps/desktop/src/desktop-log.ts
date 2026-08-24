/** Owns append-only desktop lifecycle diagnostics and bounded local rotation. */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { redactSensitiveText } from './sensitive-text-redactor.ts'

/** Explicit storage and redaction settings for desktop diagnostics. */
export interface DesktopLogConfig {
  /** Product-owned directory that contains desktop logs. */
  readonly directory: string
  /** Byte threshold at which the current log rotates before the next append. */
  readonly maxBytes: number
  /** Literal values removed from lifecycle messages before persistence. */
  readonly sensitiveValues: readonly string[]
}

/** One desktop lifecycle record persisted as a JSON line. */
export interface DesktopLogEvent {
  /** Caller-supplied ISO timestamp for deterministic lifecycle ordering. */
  readonly timestamp: string
  /** Stable lifecycle event name. */
  readonly type: string
  /** Human-readable diagnostic passed through sensitive-text redaction. */
  readonly message: string
}

/** Writes desktop lifecycle events to the current product-owned log. */
export class DesktopLog {
  readonly #currentPath: string
  readonly #rotatedPath: string
  readonly #maxBytes: number
  readonly #sensitiveValues: readonly string[]

  /**
   * Create the owned log directory and bind explicit rotation settings.
   * @param config - Product-owned directory, byte threshold, and sensitive literals.
   */
  constructor(config: DesktopLogConfig) {
    if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) {
      throw new Error('Desktop log maxBytes must be a positive integer')
    }
    mkdirSync(config.directory, { recursive: true })
    this.#currentPath = resolve(config.directory, 'desktop.log')
    this.#rotatedPath = resolve(config.directory, 'desktop.log.1')
    this.#maxBytes = config.maxBytes
    this.#sensitiveValues = [...config.sensitiveValues]
  }

  /**
   * Append one redacted lifecycle record, rotating the prior current log when required.
   * @param event - Lifecycle fields to serialize as one JSON line.
   */
  append(event: DesktopLogEvent): void {
    const record: DesktopLogEvent = {
      timestamp: event.timestamp,
      type: event.type,
      message: redactSensitiveText(event.message, this.#sensitiveValues),
    }
    const line = `${JSON.stringify(record)}\n`
    this.#rotateFor(Buffer.byteLength(line))
    appendFileSync(this.#currentPath, line, 'utf8')
  }

  /**
   * Return the resolved current log path without exposing its directory or rotated history.
   * @returns Absolute path to `desktop.log`.
   */
  currentPath(): string {
    return this.#currentPath
  }

  /** Rotate a non-empty current log before the appended record would cross the configured threshold. */
  #rotateFor(incomingBytes: number): void {
    if (!existsSync(this.#currentPath)) return
    const currentBytes = statSync(this.#currentPath).size
    if (currentBytes === 0 || currentBytes + incomingBytes < this.#maxBytes) return
    if (existsSync(this.#rotatedPath)) unlinkSync(this.#rotatedPath)
    renameSync(this.#currentPath, this.#rotatedPath)
  }
}
