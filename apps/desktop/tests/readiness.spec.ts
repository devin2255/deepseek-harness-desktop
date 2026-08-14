import { describe, expect, it } from 'vitest'
import { createReadinessParser } from '../src/readiness.ts'

function parserWithResults(): { readonly ready: string[]; readonly parser: ReturnType<typeof createReadinessParser> } {
  const ready: string[] = []
  return {
    ready,
    parser: createReadinessParser(url => ready.push(url)),
  }
}

describe('createReadinessParser', () => {
  it('recognizes the canonical loopback URL across stdout chunk boundaries', () => {
    const { parser, ready } = parserWithResults()

    parser.write('starting\ndsh web: http://127.0.')
    parser.write('0.1:4189 (LAN: http://192.168.1.5:4189)\n')

    expect(ready).toEqual(['http://127.0.0.1:4189'])
  })

  it('ignores unrelated lines before readiness', () => {
    const { parser, ready } = parserWithResults()

    parser.write('dsh web startup\nwarning: using a cached bundle\ndsh web: http://127.0.0.1:4200\n')

    expect(ready).toEqual(['http://127.0.0.1:4200'])
  })

  it('latches the first accepted URL exactly once', () => {
    const { parser, ready } = parserWithResults()

    parser.write('dsh web: http://127.0.0.1:4200\ndsh web: http://127.0.0.1:4201\n')

    expect(ready).toEqual(['http://127.0.0.1:4200'])
  })

  it('accepts only ports from 1 through 65535', () => {
    const lower = parserWithResults()
    const upper = parserWithResults()
    const zero = parserWithResults()
    const tooHigh = parserWithResults()

    lower.parser.write('dsh web: http://127.0.0.1:1\n')
    upper.parser.write('dsh web: http://127.0.0.1:65535\n')
    zero.parser.write('dsh web: http://127.0.0.1:0\n')
    tooHigh.parser.write('dsh web: http://127.0.0.1:65536\n')

    expect(lower.ready).toEqual(['http://127.0.0.1:1'])
    expect(upper.ready).toEqual(['http://127.0.0.1:65535'])
    expect(zero.ready).toEqual([])
    expect(tooHigh.ready).toEqual([])
  })

  it('rejects noncanonical hosts, protocols, and malformed URL suffixes', () => {
    const { parser, ready } = parserWithResults()

    parser.write([
      'dsh web: http://localhost:4200',
      'dsh web: http://192.168.1.2:4200',
      'dsh web: http://[::1]:4200',
      'dsh web: https://127.0.0.1:4200',
      'dsh web: http://127.0.0.1:4200/path',
      'dsh web: http://127.0.0.1:4200\tLAN',
      'dsh web: http://127.0.0.1:4200x',
    ].join('\n') + '\n')

    expect(ready).toEqual([])
  })

  it('accepts the CRLF line ending emitted when the CLI runs on Windows', () => {
    const { parser, ready } = parserWithResults()

    parser.write('dsh web: http://127.0.0.1:4200\r\n')

    expect(ready).toEqual(['http://127.0.0.1:4200'])
  })

  it('discards an oversized incomplete physical line instead of scanning a truncated suffix', () => {
    const { parser, ready } = parserWithResults()
    const garbage = 'x'.repeat(8 * 1024 + 1)

    parser.write(garbage)
    parser.write('dsh web: http://127.0.0.1:4200\n')
    parser.write('dsh web: http://127.0.0.1:4201\n')

    expect(ready).toEqual(['http://127.0.0.1:4201'])
  })
})
