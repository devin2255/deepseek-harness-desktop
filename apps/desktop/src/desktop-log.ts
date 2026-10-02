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
const SUPPRESSED_INPUT_MESSAGE = '[message suppressed: input limit exceeded]'

/** Explicit storage and redaction settings for desktop diagnostics. */
export interface DesktopLogConfig {
  /** Product-owned directory that contains desktop logs. */
  readonly directory: string
  /** Byte threshold at which the current log rotates before the next append. */
  readonly maxBytes: number
  /** Literal values removed from lifecycle messages before persistence. */
  readonly sensitiveValues: readonly string[]
  /** Maximum UTF-16 code units accepted from one message before fixed suppression. */
  readonly maxMessageCodeUnits: number
  /** Maximum UTF-16 code units accepted from each timestamp or event-type field. */
  readonly maxMetadataCodeUnits: number
}

/** Bounded message selected before the mandatory persistence redactor runs. */
export interface DesktopLogMessageSelection {
  /** Original message reference or the fixed input-limit marker. */
  readonly message: string
  /** Whether the original message was replaced before redaction. */
  readonly truncated: boolean
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
  readonly #maxMessageCodeUnits: number
  readonly #maxMetadataCodeUnits: number
  readonly #sensitiveValues: readonly string[]

  /**
   * Create the owned log directory and bind explicit rotation settings.
   * @param config - Product-owned directory, byte and input thresholds, and sensitive literals.
   */
  constructor(config: DesktopLogConfig) {
    if (!Number.isSafeInteger(config.maxBytes) || config.maxBytes <= 0) {
      throw new Error('Desktop log maxBytes must be a positive integer')
    }
    if (config.maxBytes < MINIMUM_RECORD_BYTES) throw new Error('Desktop log maxBytes is too small for a valid record')
    assertPositiveInputLimit(config.maxMessageCodeUnits, 'maxMessageCodeUnits')
    assertPositiveInputLimit(config.maxMetadataCodeUnits, 'maxMetadataCodeUnits')
    this.#directory = resolve(config.directory)
    ensureOrdinaryDirectory(this.#directory)
    this.#currentPath = resolve(this.#directory, 'desktop.log')
    this.#rotatedPath = resolve(this.#directory, 'desktop.log.1')
    assertOrdinaryLogFile(this.#currentPath)
    assertOrdinaryLogFile(this.#rotatedPath)
    this.#maxBytes = config.maxBytes
    this.#maxMessageCodeUnits = config.maxMessageCodeUnits
    this.#maxMetadataCodeUnits = config.maxMetadataCodeUnits
    this.#sensitiveValues = [...config.sensitiveValues]
  }

  /**
   * Append one redacted lifecycle record, rotating the prior current log when required.
   * @param event - Lifecycle fields to serialize as one JSON line.
   */
  append(event: DesktopLogEvent): void {
    const line = serializeBoundedEvent(
      event,
      this.#sensitiveValues,
      this.#maxBytes,
      this.#maxMessageCodeUnits,
      this.#maxMetadataCodeUnits,
    )
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
  maxMessageCodeUnits: number,
  maxMetadataCodeUnits: number,
): string {
  const timestamp = event.timestamp
  const type = event.type
  if (timestamp.length > maxMetadataCodeUnits || type.length > maxMetadataCodeUnits) {
    throw new Error('Desktop log metadata exceeds configured input limit')
  }
  const selection = selectMessageForRedaction(event.message, maxMessageCodeUnits)
  const message = redactSensitiveText(selection.message, sensitiveValues)
  const complete = serializeRecord(timestamp, type, message, selection.truncated)
  if (Buffer.byteLength(complete) <= maxBytes) return complete

  const empty = serializeRecord(timestamp, type, '', true)
  if (Buffer.byteLength(empty) > maxBytes) {
    throw new Error('Desktop log lifecycle metadata exceeds maxBytes')
  }
  const codePoints = Array.from(message)
  let lower = 0
  let upper = codePoints.length
  let bounded = empty
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2)
    const candidate = serializeRecord(timestamp, type, codePoints.slice(0, middle).join(''), true)
    if (Buffer.byteLength(candidate) <= maxBytes) {
      bounded = candidate
      lower = middle + 1
    } else {
      upper = middle - 1
    }
  }
  return bounded
}

/**
 * Select a bounded message for mandatory redaction using only an O(1) code-unit length check.
 * This pure operation cannot persist the returned text or replace the production redactor.
 * @param message - Caller-owned diagnostic message.
 * @param maxMessageCodeUnits - Explicit positive UTF-16 code-unit ceiling.
 * @returns The original reference when bounded, otherwise a fixed suppression marker.
 */
export function selectMessageForRedaction(
  message: string,
  maxMessageCodeUnits: number,
): DesktopLogMessageSelection {
  assertPositiveInputLimit(maxMessageCodeUnits, 'maxMessageCodeUnits')
  return message.length > maxMessageCodeUnits
    ? { message: SUPPRESSED_INPUT_MESSAGE, truncated: true }
    : { message, truncated: false }
}

/** Serialize one complete JSON line with an explicit truncation marker when required. */
function serializeRecord(timestamp: string, type: string, message: string, truncated: boolean): string {
  const record = truncated
    ? { timestamp, type, message, truncated: true }
    : { timestamp, type, message }
  return `${JSON.stringify(record)}\n`
}

/** Validate an explicit code-unit input ceiling before creating filesystem state. */
function assertPositiveInputLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Desktop log ${name} must be a positive integer`)
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
