import { describe, expect, it } from 'vitest'
import { parseNameStatus, parseNumstat } from '../src/git.ts'

describe('Task review Git porcelain', () => {
  it('maps every tracked-file status and preserves rename origins', () => {
    expect(parseNameStatus('A\0added\0M\0modified\0D\0deleted\0R100\0before\0after\0C75\0source\0copy\0T\0type\0U\0conflict\0'))
      .toEqual([
        { status: 'added', path: 'added' },
        { status: 'modified', path: 'modified' },
        { status: 'deleted', path: 'deleted' },
        { status: 'renamed', previousPath: 'before', path: 'after' },
        { status: 'copied', previousPath: 'source', path: 'copy' },
        { status: 'type-changed', path: 'type' },
        { status: 'conflicted', path: 'conflict' },
      ])
    expect(parseNameStatus('\0')).toEqual([])
    expect(() => parseNameStatus('X\0path\0')).toThrow('Unsupported Git file status')
  })

  it('rejects incomplete file and rename records', () => {
    expect(() => parseNameStatus('A\0')).toThrow('Git file-status record is incomplete')
    expect(() => parseNameStatus('R100\0')).toThrow('Git rename record is incomplete')
    expect(() => parseNameStatus('R100\0before\0')).toThrow('Git rename record is incomplete')
    expect(() => parseNameStatus('R100\0\0after\0')).toThrow('Git rename record is incomplete')
  })

  it('parses numeric, binary, and renamed numstat records', () => {
    expect(parseNumstat('2\t3\tfile\0-\t-\tbinary\0' + '4\t5\t\0old\0new\0'))
      .toEqual([
        { path: 'file', additions: 2, deletions: 3 },
        { path: 'binary', additions: null, deletions: null },
        { path: 'new', additions: 4, deletions: 5 },
      ])
    expect(parseNumstat('\0')).toEqual([])
  })

  it('rejects malformed counts, tabs, and renamed numstat paths', () => {
    for (const output of ['garbage\0', '1\tgarbage\0']) {
      expect(() => parseNumstat(output)).toThrow('Git numstat record is incomplete')
    }
    for (const value of ['NaN', '-1', '9007199254740992']) {
      expect(() => parseNumstat(`${value}\t1\tfile\0`)).toThrow('Git numstat count is invalid')
    }
    expect(() => parseNumstat('1\t2\t\0')).toThrow('Git rename numstat record is incomplete')
    expect(() => parseNumstat('1\t2\t\0old\0')).toThrow('Git rename numstat record is incomplete')
    expect(() => parseNumstat('1\t2\t\0\0new\0')).toThrow('Git rename numstat record is incomplete')
  })
})
