import { describe, expect, it } from 'vitest'
import { createReadinessParser } from '../src/readiness.ts'

const MAX_LINE_BYTES = 8 * 1024
const CANONICAL_LINE = 'dsh web: http://127.0.0.1:4200'

function parserWithResults(): { readonly ready: string[]; readonly parser: ReturnType<typeof createReadinessParser> } {
  const ready: string[] = []
  return {
    ready,
    parser: createReadinessParser(url => ready.push(url)),
  }
}

function lineWithByteLength(bytes: number): string {
  const suffixBytes = bytes - Buffer.byteLength(CANONICAL_LINE) - 1
  return `${CANONICAL_LINE} ${'x'.repeat(suffixBytes)}`
}

describe('readiness line byte limit', () => {
  it('accepts a completed canonical line whose UTF-8 length is exactly 8 KiB', () => {
    const { parser, ready } = parserWithResults()
    const line = lineWithByteLength(MAX_LINE_BYTES)

    expect(Buffer.byteLength(line)).toBe(MAX_LINE_BYTES)
    parser.write(`${line}\n`)

    expect(ready).toEqual(['http://127.0.0.1:4200'])
  })

  it('rejects an 8 KiB plus one completed line and recovers within the same chunk', () => {
    const { parser, ready } = parserWithResults()
    const oversized = lineWithByteLength(MAX_LINE_BYTES + 1)

    expect(Buffer.byteLength(oversized)).toBe(MAX_LINE_BYTES + 1)
    parser.write(`${oversized}\ndsh web: http://127.0.0.1:4201\n`)

    expect(ready).toEqual(['http://127.0.0.1:4201'])
  })

  it('counts multibyte padding that straddles the incomplete-line byte limit', () => {
    const { parser, ready } = parserWithResults()
    const belowLimit = lineWithByteLength(MAX_LINE_BYTES - 1)

    expect(Buffer.byteLength(belowLimit)).toBe(MAX_LINE_BYTES - 1)
    parser.write(belowLimit)
    parser.write('界\ndsh web: http://127.0.0.1:4201\n')

    expect(ready).toEqual(['http://127.0.0.1:4201'])
  })
})
