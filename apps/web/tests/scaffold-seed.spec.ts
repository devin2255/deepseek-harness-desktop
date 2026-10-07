import { describe, expect, it } from 'vitest'
import { realizeSeedFixture } from './scaffold.ts'

const workspaces = [
  String.raw`C:\Users\Test User\项目 "review"\workspace`,
  '/tmp/项目 "review"/workspace',
]

describe('seed fixture identity and path realization', () => {
  it.each(workspaces)('escapes replacement values for %s and remains idempotent', (workspaceCwd) => {
    const id = 'seed-"quoted"\nidentity'
    const fixture = [
      JSON.stringify({ type: 'session', id: '{{sessionId}}', cwd: '{{cwd}}/workspace' }),
      JSON.stringify({ text: '{{cwd}}/workspace/a.txt', unchanged: 'literal \\t and\na newline' }),
      '',
    ].join('\n')
    const realized = realizeSeedFixture({ workspaceCwd }, fixture, id)
    const [header, row] = realized.trimEnd().split('\n').map(line => JSON.parse(line) as unknown)

    expect(header).toEqual({ type: 'session', id, cwd: workspaceCwd })
    expect(row).toEqual({ text: `${workspaceCwd}/a.txt`, unchanged: 'literal \\t and\na newline' })
    expect(realized.endsWith('\n')).toBe(true)
    expect(realizeSeedFixture({ workspaceCwd }, realized, id)).toBe(realized)
  })

  it.each(workspaces.flatMap(workspaceCwd => [
    { workspaceCwd, recordedCwd: String.raw`C:\recorded\old workspace` },
    { workspaceCwd, recordedCwd: '/tmp/recorded/old workspace' },
  ]))('rewrites an escaped recorded cwd: $recordedCwd → $workspaceCwd', ({ workspaceCwd, recordedCwd }) => {
    const fixture = [
      JSON.stringify({ type: 'session', id: '{{sessionId}}', cwd: recordedCwd }),
      JSON.stringify({ text: `${recordedCwd}/a.txt` }),
    ].join('\n')
    const realized = realizeSeedFixture({ workspaceCwd }, fixture, 'seed')
    const [header, row] = realized.split('\n').map(line => JSON.parse(line) as unknown)

    expect(header).toEqual({ type: 'session', id: 'seed', cwd: workspaceCwd })
    expect(row).toEqual({ text: `${workspaceCwd}/a.txt` })
    expect(realizeSeedFixture({ workspaceCwd }, realized, 'seed')).toBe(realized)
  })

  it('realizes placeholders when the header has no cwd', () => {
    const workspaceCwd = workspaces[0]!
    const fixture = [
      JSON.stringify({ type: 'session', id: '{{sessionId}}' }),
      JSON.stringify({ text: '{{cwd}}/a.txt' }),
    ].join('\n')
    const [header, row] = realizeSeedFixture({ workspaceCwd }, fixture, 'seed')
      .split('\n').map(line => JSON.parse(line) as unknown)

    expect(header).toEqual({ type: 'session', id: 'seed' })
    expect(row).toEqual({ text: `${workspaceCwd}/a.txt` })
  })

  it('rejects malformed header JSON instead of repairing it', () => {
    expect(() => realizeSeedFixture({ workspaceCwd: '/tmp/workspace' }, '{invalid}\n', 'seed'))
      .toThrow(SyntaxError)
  })
})
