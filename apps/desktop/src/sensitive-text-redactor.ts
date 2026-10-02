/** Redacts sensitive literals from bounded utility-process diagnostics. */

const REDACTION = '[redacted]'
const SUPPRESSED_STDERR = '[stderr suppressed]'
const SUPPRESSED_TEXT = '[sensitive text suppressed]'
/** Limits compiled sensitive diagnostics to prevent inherited values from allocating unbounded matching state. */
const MAX_REDACTION_CODE_POINTS = 8 * 1024
/** Maximum retained stderr diagnostic suffix; decoded invalid UTF-8 uses deterministic replacement characters. */
const STDERR_TAIL_BYTES = 8 * 1024

/** A trie node for a compiled literal redactor. */
interface RedactionNode {
  readonly next: Map<string, number>
  failure: number
  readonly depth: number
  matchLength: number
}

/** A decoded code point retained until every sensitive literal that could include it has been examined. */
interface PendingCodePoint {
  readonly value: string
  /** Change to the number of redaction ranges active at this point. */
  delta: number
}

/** Return a known trie node while preserving strict indexed-access checks. */
function nodeAt(nodes: readonly RedactionNode[], index: number): RedactionNode {
  const node = nodes[index]
  if (node === undefined) throw new Error('Invalid sensitive-text redactor state')
  return node
}

/**
 * Compiles sensitive literals into an Aho-Corasick automaton.
 * The state transition loop is amortized linear in decoded stderr code points.
 */
class LiteralRedactor {
  readonly #nodes: RedactionNode[]
  readonly maxPatternLength: number
  #state = 0

  private constructor(nodes: RedactionNode[], maxPatternLength: number) {
    this.#nodes = nodes
    this.maxPatternLength = maxPatternLength
  }

  /**
   * Compile bounded literals, or return undefined when inherited values exceed diagnostic safety limits.
   * @param rawPatterns - Values that must not enter retained diagnostics.
   * @returns A bounded matcher, or undefined when stderr must be suppressed.
   */
  static compile(rawPatterns: readonly string[]): LiteralRedactor | undefined {
    const patterns = [...new Set(rawPatterns.filter(pattern => pattern.length > 0))].map(pattern => Array.from(pattern))
    let totalCodePoints = 0
    let maxPatternLength = 0
    for (const pattern of patterns) {
      totalCodePoints += pattern.length
      maxPatternLength = Math.max(maxPatternLength, pattern.length)
    }
    if (totalCodePoints > MAX_REDACTION_CODE_POINTS || maxPatternLength > MAX_REDACTION_CODE_POINTS) return undefined

    const nodes: RedactionNode[] = [{ next: new Map(), failure: 0, depth: 0, matchLength: 0 }]
    for (const pattern of patterns) {
      let nodeIndex = 0
      for (const codePoint of pattern) {
        const node = nodeAt(nodes, nodeIndex)
        const existing = node.next.get(codePoint)
        if (existing !== undefined) {
          nodeIndex = existing
          continue
        }
        if (nodes.length >= MAX_REDACTION_CODE_POINTS) return undefined
        const childIndex = nodes.length
        nodes.push({ next: new Map(), failure: 0, depth: node.depth + 1, matchLength: 0 })
        node.next.set(codePoint, childIndex)
        nodeIndex = childIndex
      }
      const terminal = nodeAt(nodes, nodeIndex)
      terminal.matchLength = Math.max(terminal.matchLength, pattern.length)
    }

    const queue: number[] = []
    for (const childIndex of nodeAt(nodes, 0).next.values()) queue.push(childIndex)
    for (let head = 0; head < queue.length; head += 1) {
      const nodeIndex = queue[head]
      if (nodeIndex === undefined) continue
      const node = nodeAt(nodes, nodeIndex)
      for (const [codePoint, childIndex] of node.next) {
        let failure = node.failure
        while (failure !== 0 && !nodeAt(nodes, failure).next.has(codePoint)) failure = nodeAt(nodes, failure).failure
        const fallback = nodeAt(nodes, failure).next.get(codePoint)
        const child = nodeAt(nodes, childIndex)
        child.failure = fallback === undefined ? 0 : fallback
        child.matchLength = Math.max(child.matchLength, nodeAt(nodes, child.failure).matchLength)
        queue.push(childIndex)
      }
    }
    return new LiteralRedactor(nodes, maxPatternLength)
  }

  /** Advance one decoded code point and return the longest sensitive literal ending at it. */
  advance(codePoint: string): number {
    while (this.#state !== 0 && !nodeAt(this.#nodes, this.#state).next.has(codePoint)) {
      this.#state = nodeAt(this.#nodes, this.#state).failure
    }
    const next = nodeAt(this.#nodes, this.#state).next.get(codePoint)
    this.#state = next === undefined ? 0 : next
    return nodeAt(this.#nodes, this.#state).matchLength
  }

  /** Return the longest sensitive prefix that is also the suffix at end of input. */
  incompleteLength(): number {
    return nodeAt(this.#nodes, this.#state).depth
  }
}

/**
 * Redact sensitive literals from a complete message without retaining a diagnostic tail.
 * @param text - Complete message to sanitize before persistence.
 * @param patterns - Non-empty sensitive values removed from the message.
 * @returns The full redacted message, or a suppression marker when patterns exceed safety limits.
 */
export function redactSensitiveText(text: string, patterns: readonly string[]): string {
  const redactor = LiteralRedactor.compile(patterns)
  if (redactor === undefined) return SUPPRESSED_TEXT
  const codePoints = Array.from(text)
  const deltas = new Int32Array(codePoints.length + 1)
  for (let index = 0; index < codePoints.length; index += 1) {
    const codePoint = codePoints[index]
    if (codePoint === undefined) continue
    const length = redactor.advance(codePoint)
    if (length === 0) continue
    addDelta(deltas, index - length + 1, 1)
    addDelta(deltas, index + 1, -1)
  }
  const incompleteLength = redactor.incompleteLength()
  if (incompleteLength > 0) {
    addDelta(deltas, codePoints.length - incompleteLength, 1)
    addDelta(deltas, codePoints.length, -1)
  }
  let activeRedactions = 0
  let redactionOpen = false
  const output: string[] = []
  for (let index = 0; index < codePoints.length; index += 1) {
    activeRedactions += deltas[index] ?? 0
    if (activeRedactions > 0) {
      if (!redactionOpen) output.push(REDACTION)
      redactionOpen = true
      continue
    }
    const codePoint = codePoints[index]
    if (codePoint !== undefined) output.push(codePoint)
    redactionOpen = false
  }
  return output.join('')
}

/** Update a known redaction range endpoint while preserving strict indexed-access checks. */
function addDelta(deltas: Int32Array, index: number, change: number): void {
  const current = deltas[index]
  if (current === undefined) throw new Error('Invalid sensitive-text redaction range')
  deltas[index] = current + change
}

/**
 * Retains a redacted, UTF-8-safe stderr tail without preserving capability or inherited-secret fragments.
 * When sensitive literal compilation exceeds 8 Ki code points or trie nodes, it suppresses raw stderr.
 */
export class RedactedStderrTail {
  readonly #decoder = new TextDecoder()
  readonly #redactor: LiteralRedactor | undefined
  #pending: PendingCodePoint[] = []
  #pendingStart = 0
  #nextDelta = 0
  #activeRedactions = 0
  #redactionOpen = false
  #tail: Buffer = Buffer.alloc(0)

  /**
   * @param patterns - Non-empty sensitive values removed before data enters the retained tail.
   */
  constructor(patterns: readonly string[]) {
    this.#redactor = LiteralRedactor.compile(patterns)
  }

  /** Consume one stderr chunk, keeping a bounded suffix that cannot contain sensitive literals. */
  write(chunk: unknown): void {
    const text = this.#decoder.decode(outputBytes(chunk), { stream: true })
    if (this.#redactor !== undefined) this.#writeText(text)
  }

  /** Flush the decoder and return the diagnostic after redacting incomplete sensitive suffixes. */
  finish(): string {
    const text = this.#decoder.decode()
    if (this.#redactor === undefined) return SUPPRESSED_STDERR
    this.#writeText(text)
    this.#markLast(this.#redactor.incompleteLength())
    this.#flushPending()
    return new TextDecoder().decode(this.#tail)
  }

  /** Scan decoded code points with a delayed bounded window so completed literals can mark their full interval. */
  #writeText(text: string): void {
    const redactor = this.#redactor
    if (redactor === undefined) return
    const emitted: string[] = []
    for (const codePoint of text) {
      this.#pending.push({ value: codePoint, delta: this.#nextDelta })
      this.#nextDelta = 0
      this.#markLast(redactor.advance(codePoint))
      while (this.#pending.length - this.#pendingStart > redactor.maxPatternLength) this.#emitOne(emitted)
    }
    this.#appendEmitted(emitted)
  }

  /** Mark a completed literal interval with constant-size range events. */
  #markLast(length: number): void {
    if (length === 0) return
    const first = this.#pending[this.#pending.length - length]
    if (first === undefined) return
    first.delta += 1
    this.#nextDelta -= 1
  }

  /** Emit every delayed code point after EOF. */
  #flushPending(): void {
    const emitted: string[] = []
    while (this.#pendingStart < this.#pending.length) this.#emitOne(emitted)
    this.#appendEmitted(emitted)
  }

  /** Emit one delayed code point and compact retained diagnostic state periodically. */
  #emitOne(emitted: string[]): void {
    const pending = this.#pending[this.#pendingStart]
    if (pending === undefined) return
    this.#pendingStart += 1
    this.#activeRedactions += pending.delta
    if (this.#activeRedactions > 0) {
      if (!this.#redactionOpen) emitted.push(REDACTION)
      this.#redactionOpen = true
    } else {
      emitted.push(pending.value)
      this.#redactionOpen = false
    }
    if (this.#pendingStart >= MAX_REDACTION_CODE_POINTS) {
      this.#pending = this.#pending.slice(this.#pendingStart)
      this.#pendingStart = 0
    }
  }

  /** Append an emitted batch once, avoiding per-code-point tail concatenation. */
  #appendEmitted(emitted: string[]): void {
    if (emitted.length > 0) this.#tail = appendUtf8Tail(this.#tail, emitted.join(''))
  }
}

/** Convert an output chunk to bytes without inspecting or logging its contents. */
function outputBytes(chunk: unknown): Buffer {
  if (typeof chunk === 'string') return Buffer.from(chunk)
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  return Buffer.from(String(chunk))
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
