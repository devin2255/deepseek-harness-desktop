import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { aggregateTasks, type TaskSessionInput } from '../src/aggregate.ts'
import { projectIntegrations } from '../src/integrations.ts'

const rootId = SessionId('root')
const revision = 'a'.repeat(64)
const commit = 'b'.repeat(40)
const args = { root_revision: revision, message: 'Integrate writers', writers: [
  { subagent_id: 'writer', revision, commit },
] }
const assignment = {
  kind: 'git-worktree', taskId: rootId, workspaceId: 'workspace', sourcePath: '/source', path: '/root',
  branch: `dsh/task-${'a'.repeat(24)}`, baseCommit: 'c'.repeat(40), sourceHead: 'c'.repeat(40),
  sourceDirty: false, sourceStatusDigest: 'd'.repeat(64), createdAt: 1,
}
const receipt = {
  kind: 'integrated', operationId: '00000000-0000-4000-8000-000000000001', taskId: rootId, workspaceId: 'workspace',
  reviewRevision: revision, headBefore: 'c'.repeat(40), headAfter: 'd'.repeat(40), integratedAt: 4,
  contributors: [{ sessionId: 'writer', branch: `dsh/task-${'b'.repeat(24)}`, commit, reviewRevision: revision }],
}
const conflict = {
  ...receipt, kind: 'conflict', conflictingSessionId: 'writer', paths: ['src/shared.ts'], detectedAt: 4,
}
delete (conflict as Partial<typeof receipt>).headAfter
delete (conflict as Partial<typeof receipt>).integratedAt

function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: seq + 1, data } as SessionEvent
}
function start(id = 'merge', seq = 1, argumentsValue: unknown = args): SessionEvent {
  return event('tool/call', seq, { turn: 0, step: 0, callId: id, name: 'integrate_agents', arguments: JSON.stringify(argumentsValue) })
}
function result(value: unknown, id = 'merge', seq = 2, isError = false): SessionEvent {
  return event('tool/result', seq, { turn: 0, step: 0, message: { role: 'user', id: `message-${seq}`,
    source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id,
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], isError }],
  } })
}
function project(events: readonly SessionEvent[], running = false, children?: TaskSessionInput[]) {
  return aggregateTasks({ generation: 1, sessions: [
    { header: { version: 0, id: rootId, createdAt: 1 }, events: [event('task/worktree-assigned', 0, { assignment }), ...events] },
    ...children ?? [{ header: { version: 0, id: SessionId('writer'), createdAt: 1, origin: 'subagent', parentSession: rootId }, events: [] }],
  ], liveFacts: running ? [{ kind: 'activity', taskId: rootId, ownerSessionId: rootId, sourceId: 'agent', state: 'running', createdAt: 1 }] : [] }).tasks[0]!
}

describe('integration nodes', () => {
  it('does not invent attempts for an uninspectable log', () => {
    expect(projectIntegrations({ header: { version: 0, id: rootId, createdAt: 1 } },
      project([]).executionWorkspace, [], false)).toEqual([])
  })

  it('projects exact successful receipts and preserves identity through cold replay', () => {
    const events = [start(), result(receipt)]
    const live = project(events, true)
    expect(live.integrations).toEqual([{ id: 'root:integration:1', callSeq: 1, startedAt: 2,
      writerSessionIds: ['writer'], outcome: { kind: 'integrated', result: receipt }, finishedAt: 3 }])
    expect(project(structuredClone(events)).integrations).toEqual(live.integrations)
    expect(live.commitReceipt).toBeUndefined()
    expect(live.attention).toEqual([])
  })

  it('never assumes an unfinished call succeeded or continues running after live ownership is lost', () => {
    expect(project([start()], true).integrations?.[0]?.outcome.kind).toBe('running')
    expect(project([start()]).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(project([start(), result('cancelled', 'merge', 2, true)]).integrations?.[0]?.outcome.kind).toBe('failed')
  })

  it('adds exact conflict attention and only resolves it when later successes cover every selected writer', () => {
    const blocked = project([start(), result(conflict)])
    expect(blocked.status).toBe('needs-attention')
    expect(blocked.attention).toMatchObject([{ id: 'root:integration:1', kind: 'merge-conflict', ownerSessionId: rootId,
      actionable: true, sourceId: 'root:integration:1', summary: 'src/shared.ts' }])
    const unrelatedArgs = { ...args, writers: [{ ...args.writers[0], subagent_id: 'other' }] }
    const other = { ...receipt, contributors: [{ ...receipt.contributors[0], sessionId: 'other' }] }
    const children: TaskSessionInput[] = ['writer', 'other'].map(id => ({ header: {
      version: 0, id: SessionId(id), createdAt: 1, origin: 'subagent', parentSession: rootId,
    }, events: [] }))
    const events = [start(), result(conflict), start('other', 3, unrelatedArgs), result(other, 'other', 4)]
    expect(project(events, false, children).attention).toHaveLength(1)
    const resolved = project([...events, start('retry', 5), result(receipt, 'retry', 6)], false, children)
    expect(resolved.attention).toEqual([])
    expect(resolved.integrations?.[0]?.resolvedBy).toBe('root:integration:5')
  })

  it.each([
    { ...receipt, taskId: 'foreign' }, { ...receipt, workspaceId: 'foreign' },
    { ...receipt, reviewRevision: 'e'.repeat(64) }, { ...receipt, unexpected: true },
    { ...receipt, operationId: '00000000-0000-0000-0000-000000000000' },
    { ...receipt, operationId: 'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF' },
    { ...receipt, operationId: 'ffffffff-ffff-ffff-ffff-ffffffffffff' },
    { ...receipt, contributors: [{ ...receipt.contributors[0], commit: 'e'.repeat(40) }] },
    { ...conflict, paths: ['../outside'] }, { ...conflict, conflictingSessionId: 'foreign' },
    'truncated preview',
  ])('does not confirm foreign, mismatched, malformed, or truncated results (%#)', (value) => {
    const row = project([start(), result(value)])
    expect(row.integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(row.attention).toEqual([])
  })

  it('rejects success attributed to a foreign child or an unpaired tool result', () => {
    expect(project([start(), result(receipt)], false, []).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(project([result(receipt)]).integrations).toBeUndefined()
    const mismatch = result(receipt)
    expect(project([start(), { ...mismatch, data: { ...mismatch.data, turn: 1 } } as SessionEvent]).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
  })

  it('projects code-mode sub-dispatches through the same receipt checks', () => {
    const data = { rootCallId: 'code', parentCallId: 'code', subCallId: 'code:code:1', name: 'integrate_agents', arguments: args }
    const row = project([event('tool/code-dispatch-start', 1, data), event('tool/code-dispatch', 2, {
      ...data, isError: false, content: [{ type: 'text', text: JSON.stringify(conflict) }],
    })])
    expect(row.integrations?.[0]?.outcome).toEqual({ kind: 'conflict', result: conflict })
    expect(row.attention).toHaveLength(1)
  })

  it('closes unfinished native and code attempts at their recorded lifecycle boundaries', () => {
    const code = event('tool/code-dispatch-start', 1, {
      rootCallId: 'code', parentCallId: 'code', subCallId: 'code:code:1', name: 'integrate_agents', arguments: args,
    })
    expect(project([start(), event('step/end', 2, { turn: 0, step: 0 })], true).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(project([code, event('turn/end', 2, { turn: 0, reason: { kind: 'interrupted' } })], true).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(project([code, result('code done', 'code')], true).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(project([start(), event('step/end', 2, { turn: 1, step: 0 })], true).integrations?.[0]?.outcome.kind).toBe('running')
    expect(project([code, event('step/end', 2, { turn: 0, step: 0 })], true).integrations?.[0]?.outcome.kind).toBe('running')
  })

  it('rejects uncorrelated code completions and retains conflicts after failed retries', () => {
    const data = { rootCallId: 'code', parentCallId: 'code', subCallId: 'code:code:1', name: 'integrate_agents', arguments: args }
    for (const patch of [
      { name: 'other' }, { subCallId: 'absent' }, { parentCallId: 'other' }, { rootCallId: 'other' }, { arguments: {} },
    ]) {
      const row = project([event('tool/code-dispatch-start', 1, data),
        event('tool/code-dispatch', 2, { ...data, ...patch, isError: false, content: [{ type: 'text', text: JSON.stringify(receipt) }] })])
      expect(row.integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    }
    const blocked = project([start(), result(conflict), start('retry', 3), result('failed', 'retry', 4, true)])
    expect(blocked.attention).toHaveLength(1)
    expect(blocked.integrations?.[0]?.resolvedBy).toBeUndefined()
  })

  it('does not accept duplicate results, duplicate call identities, invalid arguments, or non-text receipts', () => {
    expect(project([start(), result(receipt), result(receipt, 'merge', 3)]).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    expect(project([start(), result(receipt), start('merge', 3)]).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    const invalid = start('merge', 1, { ...args, writers: [args.writers[0], args.writers[0]] })
    expect(project([invalid, result(receipt)]).integrations?.[0]?.writerSessionIds).toEqual([])
    const malformed = start()
    expect(project([{ ...malformed, data: { ...malformed.data, arguments: '{' } } as SessionEvent, result(receipt)]).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
    for (const content of [[], [{ type: 'image', source: { type: 'url', url: 'https://fixture.invalid/image' } }]]) {
      const data = { turn: 0, step: 0, message: { content: [{ type: 'tool-result', toolCallId: 'merge', content }] } }
      expect(project([start(), event('tool/result', 2, data)]).integrations?.[0]?.outcome.kind).toBe('unconfirmed')
      expect(project([start(), event('tool/result', 2, { ...data, message: { content: [{ ...data.message.content[0], isError: true }] } })]).integrations?.[0]?.outcome.kind).toBe('failed')
    }
  })

  it('does not clear a multi-writer conflict after only part of its batch succeeds', () => {
    const batch = { ...args, writers: [...args.writers, { ...args.writers[0]!, subagent_id: 'other' }] }
    const conflictBatch = { ...conflict, contributors: [...conflict.contributors, { ...conflict.contributors[0]!, sessionId: 'other' }] }
    const children: TaskSessionInput[] = ['writer', 'other'].map(id => ({ header: {
      version: 0, id: SessionId(id), createdAt: 1, origin: 'subagent', parentSession: rootId,
    }, events: [] }))
    const events = [start('batch', 1, batch), result(conflictBatch, 'batch', 2), start('part', 3), result(receipt, 'part', 4)]
    expect(project(events, false, children).attention).toHaveLength(1)
    const otherArgs = { ...args, writers: [{ ...args.writers[0]!, subagent_id: 'other', commit: 'e'.repeat(40) }] }
    const revised = { ...receipt, contributors: [{ ...receipt.contributors[0]!, sessionId: 'other', commit: 'e'.repeat(40) }] }
    expect(project([...events, start('remaining', 5, otherArgs), result(revised, 'remaining', 6)], false, children).attention).toEqual([])
  })
})
