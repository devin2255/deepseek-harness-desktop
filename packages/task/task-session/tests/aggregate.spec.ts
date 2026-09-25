import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { AttentionItemId, TaskCriterionId, type LiveTaskFact } from '@deepseek-ai/dsh-task'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { TaskReviewOperationId, TaskReviewRevision } from '@deepseek-ai/dsh-task-review'
import { aggregateTasks, sortAttentionItems, TaskLineageError, type TaskSessionInput } from '../src/aggregate.ts'

const sid = SessionId
const header = (id: string, options: Partial<SessionHeader> = {}): SessionHeader => ({
  version: 0, id: sid(id), createdAt: options.createdAt ?? 1, ...options,
})
const input = (id: string, options: Partial<SessionHeader> = {}, events: readonly SessionEvent[] = []): TaskSessionInput => ({
  header: header(id, options), events,
})
const event = (type: string, seq: number, time: number, data: unknown): SessionEvent => ({ type, seq, time, data } as SessionEvent)
const assignment: TaskWorktreeAssignment = {
  kind: 'git-worktree', taskId: sid('root'), workspaceId: 'workspace' as TaskWorktreeAssignment['workspaceId'],
  sourcePath: 'D:\\repos\\source', path: 'D:\\harness\\worktrees\\root',
  branch: 'dsh/task-0123456789abcdef01234567',
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
  sourceHead: '0123456789abcdef0123456789abcdef01234567', sourceDirty: false,
  sourceStatusDigest: 'a'.repeat(64), createdAt: 1,
}
const commitReceipt = {
  kind: 'commit' as const, operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000001'),
  taskId: sid('root'), workspaceId: assignment.workspaceId,
  reviewRevision: TaskReviewRevision('b'.repeat(64)), committedRevision: TaskReviewRevision('c'.repeat(64)),
  branch: assignment.branch, commit: '1'.repeat(40), committedAt: 8,
}
const applyReceipt = {
  kind: 'apply' as const, operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000002'),
  taskId: sid('root'), workspaceId: assignment.workspaceId,
  reviewRevision: commitReceipt.committedRevision, commit: commitReceipt.commit,
  sourceHeadBefore: '2'.repeat(40), sourceHeadAfter: '2'.repeat(40), appliedAt: 9,
}
const discardReceipt = {
  kind: 'discard' as const, operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000003'),
  taskId: sid('root'), workspaceId: assignment.workspaceId,
  reviewRevision: commitReceipt.committedRevision, branch: assignment.branch,
  branchPreserved: true, worktreeRemoved: true, uncommittedChangesDiscarded: false,
  recoverableCommit: commitReceipt.commit, discardedAt: 10,
}
const liveAttention = (taskId: string, owner: string, sourceId: string, severity: 'info' | 'warning' | 'error' | 'critical' = 'warning'): LiveTaskFact => ({
  kind: 'attention',
  item: {
    id: AttentionItemId(`${owner}:${sourceId}`), taskId: sid(taskId), ownerSessionId: sid(owner), kind: 'question', severity,
    summary: sourceId, createdAt: 10, sourceId, actionable: true,
  },
})

describe('aggregateTasks', () => {
  it('discovers roots and follows uninterrupted subagent ancestry', () => {
    const result = aggregateTasks({ generation: 1, sessions: [
      input('root'),
      input('child', { origin: 'subagent', parentSession: sid('root') }),
      input('grandchild', { origin: 'subagent', parentSession: sid('child') }),
    ] })
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]?.descendantSessionIds).toEqual([sid('child'), sid('grandchild')])
  })

  it('projects the durable execution worktree and uses its Workspace identity', () => {
    const result = aggregateTasks({
      generation: 1,
      sessions: [input('root', {}, [event('task/worktree-assigned', 0, 2, { assignment })])],
      workspaceBySession: new Map([[sid('root'), 'stale-workspace' as never]]),
    }).tasks[0]

    expect(result).toMatchObject({ workspaceId: 'workspace', executionWorkspace: assignment, asOfSeq: 1 })
    expect(result?.executionWorkspace).not.toBe(assignment)
  })

  it('keeps an ordinary fork as an independent root', () => {
    const result = aggregateTasks({ generation: 1, sessions: [
      input('root'), input('fork', { parentSession: sid('root'), seedLength: 0 }),
    ] })
    expect(result.tasks.map(task => task.taskId)).toEqual([sid('fork'), sid('root')])
  })

  it('rejects cycles and missing subagent ancestry', () => {
    expect(() => aggregateTasks({ generation: 1, sessions: [
      input('a', { origin: 'subagent', parentSession: sid('b') }),
      input('b', { origin: 'subagent', parentSession: sid('a') }),
    ] })).toThrow(TaskLineageError)
    expect(() => aggregateTasks({ generation: 1, sessions: [
      input('child', { origin: 'subagent', parentSession: sid('missing') }),
    ] })).toThrow(/missing Session/)
    expect(() => aggregateTasks({ generation: 1, sessions: [
      input('child', { origin: 'subagent' }),
    ] })).toThrow(/has no parent Session/)
  })

  it('marks a root unavailable when a known descendant log cannot be inspected', () => {
    const result = aggregateTasks({ generation: 1, sessions: [
      input('root'), { header: header('child', { origin: 'subagent', parentSession: sid('root') }) },
    ] })
    expect(result.tasks[0]?.freshness).toBe('unavailable')
    expect(result.tasks[0]?.descendantSessionIds).toEqual([sid('child')])
  })

  it('applies status precedence and never infers ready from idleness', () => {
    const defined = event('task/defined', 0, 2, { definition: { goal: 'ship', criteria: [
      { id: TaskCriterionId('done'), text: 'done', status: 'pending', evidence: [] },
    ] } })
    const running: LiveTaskFact = { kind: 'activity', taskId: sid('root'), ownerSessionId: sid('root'), sourceId: 'run', state: 'running', createdAt: 3 }
    expect(aggregateTasks({ generation: 1, sessions: [input('root', {}, [defined])], liveFacts: [running] }).tasks[0]?.status).toBe('running')
    expect(aggregateTasks({ generation: 1, sessions: [input('root', {}, [defined])] }).tasks[0]?.status).toBe('reviewing')
    expect(aggregateTasks({ generation: 1, sessions: [input('root')], liveFacts: [running, liveAttention('root', 'root', 'q')] }).tasks[0]?.status).toBe('needs-attention')
  })

  it('replays and settles exact approval identities without clearing siblings', () => {
    const events = [
      event('approval/asked', 0, 2, { id: 'q1', toolName: 'bash' }),
      event('approval/asked', 1, 3, { id: 'a1', toolName: 'write' }),
      event('approval/decided', 2, 4, { id: 'q1', outcome: 'rejected' }),
    ]
    const result = aggregateTasks({ generation: 1, sessions: [input('root', {}, events)] })
    expect(result.tasks[0]?.attention.map(item => item.sourceId)).toEqual(['a1'])
  })

  it('sorts attention by actionability, severity, creation time, task update, and identity', () => {
    const facts = [
      liveAttention('root', 'root', 'warning', 'warning'),
      liveAttention('root', 'root', 'critical', 'critical'),
      liveAttention('root', 'root', 'error', 'error'),
    ]
    const result = aggregateTasks({ generation: 1, sessions: [input('root')], liveFacts: facts })
    expect(result.tasks[0]?.attention.map(item => item.sourceId)).toEqual(['critical', 'error', 'warning'])
  })

  it('uses every stable attention tie breaker across root Tasks', () => {
    const item = (id: string, taskId: string, actionable: boolean, severity: 'info' | 'warning' | 'error' | 'critical', createdAt: number) => ({
      id: AttentionItemId(id), taskId: sid(taskId), ownerSessionId: sid(taskId), kind: 'question' as const,
      severity, summary: id, createdAt, sourceId: id, actionable,
    })
    const ordered = sortAttentionItems([
      item('z', 'b', false, 'info', 2),
      item('z', 'a', true, 'warning', 2),
      item('b', 'a', true, 'warning', 2),
      item('a', 'a', true, 'warning', 2),
      item('old-task', 'c', true, 'warning', 2),
      item('early', 'd', true, 'warning', 1),
      item('critical', 'e', true, 'critical', 2),
    ], new Map([[sid('a'), 3], [sid('c'), 1], [sid('d'), 3], [sid('e'), 3]]))
    expect(ordered.map(current => current.id)).toEqual([
      AttentionItemId('critical'), AttentionItemId('early'), AttentionItemId('old-task'),
      AttentionItemId('a'), AttentionItemId('b'), AttentionItemId('z'), AttentionItemId('z'),
    ])
  })

  it('derives durable failures, clears them after a later success, and preserves approval reasons', () => {
    const failure = event('turn/end', 0, 2, { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } })
    const asked = event('approval/asked', 1, 3, { id: 'approval', toolName: 'bash', reason: 'write files' })
    const failed = aggregateTasks({ generation: 1, sessions: [input('root', {}, [failure, asked])] }).tasks[0]
    expect(failed).toMatchObject({ status: 'needs-attention', attention: [
      { sourceId: 'approval', summary: 'write files' }, { sourceId: 'turn:1', summary: 'boom' },
    ] })
    const completed = event('turn/end', 2, 4, { turn: 2, reason: { kind: 'completed' } })
    const settled = aggregateTasks({ generation: 1, sessions: [input('root', {}, [failure, completed])] }).tasks[0]
    expect(settled).toMatchObject({ status: 'settled', attention: [] })
  })

  it('projects a crash-repaired interrupted turn as a durable Task failure', () => {
    const interrupted = event('turn/end', 0, 7, { turn: 3, reason: { kind: 'interrupted' } })
    const failed = aggregateTasks({ generation: 1, sessions: [input('root', {}, [interrupted])] }).tasks[0]

    expect(failed).toMatchObject({
      status: 'failed',
      attention: [{
        ownerSessionId: sid('root'),
        kind: 'run-failure',
        severity: 'error',
        sourceId: 'turn:3',
        summary: 'This Task was interrupted before the turn completed. Review the last tool result before continuing.',
        actionable: false,
      }],
    })
  })

  it('reports failed activity below actionable attention and above running activity', () => {
    const running: LiveTaskFact = { kind: 'activity', taskId: sid('root'), ownerSessionId: sid('root'), sourceId: 'run', state: 'running', createdAt: 2 }
    const failed: LiveTaskFact = { ...running, sourceId: 'failed', state: 'failed' }
    expect(aggregateTasks({ generation: 1, sessions: [input('root')], liveFacts: [running, failed] }).tasks[0]?.status).toBe('failed')
  })

  it('requires explicit readiness and projects workspace, risks, decision, and disconnected freshness', () => {
    const events = [
      event('task/defined', 0, 2, { definition: { goal: 'ship', criteria: [
        { id: TaskCriterionId('done'), text: 'done', status: 'pending', evidence: [] },
      ] } }),
      event('task/criterion-updated', 1, 3, { criterion: {
        id: TaskCriterionId('done'), text: 'done', status: 'satisfied', evidence: [{ sessionId: sid('root'), seq: 0 }],
      } }),
      event('task/risk-recorded', 2, 4, { risk: { id: 'risk', severity: 'low', summary: 'known', resolution: 'fixed' } }),
      event('task/review-decided', 3, 5, { decision: 'ready' }),
    ]
    const result = aggregateTasks({
      generation: 3,
      sessions: [input('root', {}, events)],
      freshness: 'disconnected',
      workspaceBySession: new Map([[sid('root'), 'workspace' as never]]),
    }).tasks[0]
    expect(result).toMatchObject({ status: 'ready', freshness: 'disconnected', workspaceId: 'workspace', reviewDecision: 'ready' })
  })

  it('projects durable delivery receipts and treats them as settled', () => {
    const defined = event('task/defined', 0, 2, { definition: { goal: 'ship', criteria: [
      { id: TaskCriterionId('done'), text: 'done', status: 'pending', evidence: [] },
    ] } })
    const satisfied = event('task/criterion-updated', 1, 3, { criterion: {
      id: TaskCriterionId('done'), text: 'done', status: 'satisfied', evidence: [{ sessionId: sid('root'), seq: 0 }],
    } })
    const ready = event('task/review-decided', 2, 4, { decision: 'ready' })
    const assigned = event('task/worktree-assigned', 0, 1, { assignment })
    const committed = event('task/review-committed', 4, 6, { receipt: commitReceipt })
    const applied = event('task/review-applied', 5, 7, { receipt: applyReceipt })
    const discarded = event('task/review-discarded', 6, 8, { receipt: discardReceipt })
    for (const events of [
      [assigned, defined, satisfied, ready, committed],
      [assigned, defined, satisfied, ready, committed, applied],
      [assigned, defined, satisfied, ready, committed, applied, discarded],
    ]) {
      expect(aggregateTasks({ generation: 1, sessions: [input('root', {}, events)] }).tasks[0]?.status).toBe('settled')
    }
    expect(aggregateTasks({ generation: 1, sessions: [input('root', {}, [
      assigned, defined, satisfied, ready, committed, applied, discarded,
    ])] }).tasks[0]).toMatchObject({ commitReceipt, applyReceipt, discardReceipt })
  })

  it('ignores live facts whose owner is missing or belongs to another root', () => {
    const missing: LiveTaskFact = { kind: 'activity', taskId: sid('root'), ownerSessionId: sid('missing'), sourceId: 'x', state: 'running', createdAt: 2 }
    const foreign: LiveTaskFact = { kind: 'activity', taskId: sid('other'), ownerSessionId: sid('root'), sourceId: 'y', state: 'running', createdAt: 3 }
    expect(aggregateTasks({ generation: 1, sessions: [input('root')], liveFacts: [missing, foreign] }).tasks[0]?.status).toBe('settled')
  })

  it('uses real immutable Session logs and returns detached snapshots', () => {
    const session = Session.create(sid('root'))
    session.append('task/defined', { definition: { goal: 'ship', criteria: [
      { id: TaskCriterionId('installer'), text: 'installer works', status: 'pending', evidence: [] },
    ] } })
    const result = aggregateTasks({ generation: 7, sessions: [{ header: session.header, events: session.events }] })
    expect(result).toMatchObject({ generation: 7, tasks: [{ taskId: 'root', asOfSeq: 1, status: 'reviewing' }] })
    expect(result.tasks[0]?.definition).not.toBe(session.events[0]?.data)
  })
})
