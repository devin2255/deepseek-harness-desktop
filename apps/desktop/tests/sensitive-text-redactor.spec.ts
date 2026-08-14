import { describe, expect, it } from 'vitest'
import { RedactedStderrTail } from '../src/sensitive-text-redactor.ts'

describe('RedactedStderrTail', () => {
  it('redacts overlapping, shared-prefix, and Unicode literals across chunks', () => {
    const tail = new RedactedStderrTail(['A'.repeat(43), '秘密共享', '秘密共享更长'])

    tail.write('before AAAAAAAAAAAAAAAAAAAAA')
    tail.write('AAAAAAAAAAAAAAAAAAAAAA! 秘密共享更')
    tail.write('长 after')

    const diagnostic = tail.finish()
    expect(diagnostic).toBe('before [redacted]! [redacted] after')
    expect(diagnostic).not.toMatch(/A{8}/u)
    expect(diagnostic).not.toContain('秘密共享')
  })

  it('redacts an incomplete sensitive suffix at EOF', () => {
    const tail = new RedactedStderrTail(['non-repetitive-sensitive-value'])

    tail.write('unrelated diagnostic non-repetitive-sensitive')

    expect(tail.finish()).toBe('unrelated diagnostic [redacted]')
  })

  it('handles a large common-prefix stream with a bounded UTF-8 tail', () => {
    const patterns = Array.from(
      { length: 24 },
      (_, index) => `shared-prefix-${index.toString().padStart(2, '0')}-sensitive-value`,
    )
    const tail = new RedactedStderrTail(patterns)
    const target = patterns[23]
    const beganAt = performance.now()

    tail.write(`${'x'.repeat(64 * 1024)}\ncontext ${target}\nfinal diagnostic`)

    const diagnostic = tail.finish()
    expect(performance.now() - beganAt).toBeLessThan(1_000)
    expect(diagnostic).toContain('[redacted]')
    expect(diagnostic).toContain('final diagnostic')
    expect(diagnostic).not.toContain(target)
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(8 * 1024)
  })

  it('suppresses raw diagnostics when compiling inherited literals would exceed its safety limit', () => {
    const tail = new RedactedStderrTail(['x'.repeat(8 * 1024 + 1)])
    tail.write('must not appear')

    expect(tail.finish()).toBe('[stderr suppressed]')
  })
})
