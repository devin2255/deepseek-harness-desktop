/**
 * Acceptance-path coverage for idempotent exact edits and product identifiers
 * that resemble vendored package specifiers.
 */

import { describe, expect, it } from 'vitest'
import { exactEditState, patterns, rewriteLine } from './rescope-vendor.ts'

const ANCHOR = '\n## Sync procedure'
const INSERTED = `\n15. **rescope**: one log entry.\n${ANCHOR}`

describe('exactEditState', () => {
  it('classifies an insertion by its target form, so a duplicate is invalid', () => {
    expect(exactEditState(`log\n${ANCHOR}\n`, ANCHOR, INSERTED, 1)).toBe('pending')
    expect(exactEditState(`log${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('applied')
    // The anchor survives an insertion, so counting the source form would have
    // called this pending and inserted the entry a second time.
    expect(exactEditState(`log${INSERTED}${INSERTED}\n`, ANCHOR, INSERTED, 1)).toBe('invalid')
    expect(exactEditState('log\n', ANCHOR, INSERTED, 1)).toBe('invalid')
  })

  it('classifies a deletion by its source form, and requires its remainder to survive', () => {
    const remainder = 'exclude:\n'
    const withEntries = 'exclude:\n  - cordis@4\n'
    expect(exactEditState(withEntries, withEntries, remainder, 1)).toBe('pending')
    expect(exactEditState(remainder, withEntries, remainder, 1)).toBe('applied')
    // Upstream dropped the whole field: the source form is gone, but so is the
    // remainder, so this is a moved site rather than a completed deletion.
    expect(exactEditState('unrelated:\n', withEntries, remainder, 1)).toBe('invalid')
  })

  it('requires a replacement to leave no source form and the exact target count', () => {
    expect(exactEditState('a = 1\n', 'a = 1', 'b = 2', 1)).toBe('pending')
    expect(exactEditState('b = 2\n', 'a = 1', 'b = 2', 1)).toBe('applied')
    expect(exactEditState('b = 2\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    // A moved or partially applied site: neither state is complete.
    expect(exactEditState('a = 1\nb = 2\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
    expect(exactEditState('x\n', 'a = 1', 'b = 2', 1)).toBe('invalid')
  })
})

describe('vendored package token rewrite', () => {
  const mappings = patterns(false)

  it('rewrites real Cordis exports without changing unrelated event identifiers', () => {
    expect(rewriteLine("from 'cordis/src/index'", 'sample.ts', mappings)).toBe("from '@deepseek-ai/cordis/src/index'")
    expect(rewriteLine("from 'cordis/package.json'", 'sample.ts', mappings)).toBe("from '@deepseek-ai/cordis/package.json'")
    expect(rewriteLine("ctx.emit('cordis/request-run')", 'sample.ts', mappings)).toBe("ctx.emit('cordis/request-run')")
  })

  it('preserves the Cordis UI namespace while still rewriting package imports', () => {
    const file = 'packages/extensions/ui-cordis/src/client/index.ts'
    expect(rewriteLine("name: 'cordis'", file, mappings)).toBe("name: 'cordis'")
    expect(rewriteLine("from 'cosmokit'", file, mappings)).toBe("from '@deepseek-ai/cosmokit'")
  })
})
