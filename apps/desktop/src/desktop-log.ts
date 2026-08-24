/** Owns append-only desktop lifecycle diagnostics and bounded local rotation. */

import { appendFileSync, lstatSync, mkdirSync, renameSync, unlinkSync, type Stats } from 'node:fs'
import { join, parse, relative, resolve, sep } from 'node:path'
import { redactSensitiveText } from './sensitive-text-redactor.ts'

const MINIMUM_RECORD_BYTES = Buffer.byteLength(
  `${JSON.stringify({
    timestamp: '0000-01-01T00:00:00.000Z',
    type: 'x',
    message: '',
    truncated: true,
  })}\n`,
)

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
  readonly #directory: string
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
    if (config.maxBytes < MINIMUM_RECORD_BYTES) throw new Error('Desktop log maxBytes is too small for a valid record')
    this.#directory = resolve(config.directory)
    ensureOrdinaryDirectory(this.#directory)
    this.#currentPath = resolve(this.#directory, 'desktop.log')
    this.#rotatedPath = resolve(this.#directory, 'desktop.log.1')
    assertOrdinaryLogFile(this.#currentPath)
    assertOrdinaryLogFile(this.#rotatedPath)
    this.#maxBytes = config.maxBytes
    this.#sensitiveValues = [...config.sensitiveValues]
  }

  /**
   * Append one redacted lifecycle record, rotating the prior current log when required.
   * @param event - Lifecycle fields to serialize as one JSON line.
   */
  append(event: DesktopLogEvent): void {
    const line = serializeBoundedEvent(event, this.#sensitiveValues, this.#maxBytes)
    this.#assertOwnedPaths()
    this.#rotateFor(Buffer.byteLength(line))
    this.#assertOwnedPaths()
    appendFileSync(this.#currentPath, line, 'utf8')
  }

  /**
   * Return the resolved current log path without exposing its directory or rotated history.
   * @returns Absolute path to `desktop.log`.
   */
  currentPath(): string {
    return this.#currentPath
  }

  /** Rotate a non-empty current log before the appended record would reach the configured threshold. */
  #rotateFor(incomingBytes: number): void {
    const current = assertOrdinaryLogFile(this.#currentPath)
    if (current === undefined) return
    const currentBytes = current.size
    if (currentBytes === 0 || currentBytes + incomingBytes < this.#maxBytes) return
    const rotated = assertOrdinaryLogFile(this.#rotatedPath)
    if (rotated !== undefined) unlinkSync(this.#rotatedPath)
    assertOrdinaryLogFile(this.#currentPath)
    renameSync(this.#currentPath, this.#rotatedPath)
  }

  /** Recheck every owned filesystem component immediately before mutation. */
  #assertOwnedPaths(): void {
    ensureOrdinaryDirectory(this.#directory)
    assertOrdinaryLogFile(this.#currentPath)
    assertOrdinaryLogFile(this.#rotatedPath)
  }
}

/** Serialize an event within the configured UTF-8 byte ceiling after full-message redaction. */
function serializeBoundedEvent(
  event: DesktopLogEvent,
  sensitiveValues: readonly string[],
  maxBytes: number,
): string {
  const message = redactSensitiveText(event.message, sensitiveValues)
  const complete = serializeRecord(event, message, false)
  if (Buffer.byteLength(complete) <= maxBytes) return complete

  const empty = serializeRecord(event, '', true)
  if (Buffer.byteLength(empty) > maxBytes) {
    throw new Error('Desktop log lifecycle metadata exceeds maxBytes')
  }
  const codePoints = Array.from(message)
  let lower = 0
  let upper = codePoints.length
  let bounded = empty
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const candidate = serializeRecord(event, codePoints.slice(0, middle).join(''), true)
    if (Buffer.byteLength(candidate) <= maxBytes) {
      bounded = candidate
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  return bounded
}

/** Serialize one complete JSON line with an explicit truncation marker when required. */
function serializeRecord(event: DesktopLogEvent, message: string, truncated: boolean): string {
  const record = truncated
    ? { timestamp: event.timestamp, type: event.type, message, truncated: true }
    : { timestamp: event.timestamp, type: event.type, message }
  return `${JSON.stringify(record)}\n`
}

/** Create missing path components while rejecting links and non-directory ancestors. */
function ensureOrdinaryDirectory(directory: string): void {
  const root = parse(directory).root
  assertDirectory(root)
  let current = root
  const remainder = relative(root, directory)
  for (const component of remainder.split(sep).filter(part => part.length > 0)) {
    current = join(current, component)
    const status = lstatIfExists(current)
    if (status === undefined) mkdirSync(current)
    assertDirectory(current)
  }
}

/** Reject a symbolic link, junction, or non-directory component. */
function assertDirectory(path: string): void {
  const status = lstatIfExists(path)
  if (status?.isSymbolicLink() === true) throw new Error(`Desktop log path is a symbolic link or junction: ${path}`)
  if (status === undefined || !status.isDirectory()) throw new Error(`Desktop log path is not an ordinary directory: ${path}`)
}

/** Return an ordinary log file status, allowing only absence as an alternative. */
function assertOrdinaryLogFile(path: string): Stats | undefined {
  const status = lstatIfExists(path)
  if (status?.isSymbolicLink() === true) throw new Error(`Desktop log path is a symbolic link or junction: ${path}`)
  if (status !== undefined && !status.isFile()) throw new Error(`Desktop log path is not an ordinary file: ${path}`)
  return status
}

/** Read final-component properties without following links, preserving non-absence failures. */
function lstatIfExists(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Narrow filesystem errors without assuming hostile values at typed boundaries. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
