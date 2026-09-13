import { describe, expect, it } from 'vitest'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  TaskCriterionId,
  TaskLogError,
  TaskRiskId,
  applyTaskEvent,
  emptyTaskFoldState,
  foldTask,
} from '@deepseek-ai/dsh-task'
import type { TaskCriterion, TaskDefinition, TaskRisk } from '@deepseek-ai/dsh-task'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import {
  TaskReviewOperationId,
  TaskReviewRevision,
  type TaskApplyReceipt,
  type TaskCommitReceipt,
  type TaskDiscardReceipt,
} from '@deepseek-ai/dsh-task-review'

const firstCriterion: TaskCriterion = {
  id: TaskCriterionId('installer'),
  text: 'Installer launches the application',
  status: 'pending',
  evidence: [],
}

const secondCriterion: TaskCriterion = {
  id: TaskCriterionId('parallel-agents'),
  text: 'One window manages parallel agents',
  status: 'pending',
  evidence: [],
}

function definition(goal = 'Ship the desktop product'): TaskDefinition {
  return { goal, criteria: [firstCriterion, secondCriterion] }
}

function event(type: string, data: unknown, seq: number, time = 1_700_000_000_000 + seq): SessionEvent {
  return { type, data, seq, time } as SessionEvent
}

const defined = (value: TaskDefinition, seq = 0): SessionEvent =>
  event('task/defined', { definition: value }, seq)

const criterionUpdated = (criterion: TaskCriterion, seq = 1): SessionEvent =>
  event('task/criterion-updated', { criterion }, seq)

const riskRecorded = (risk: TaskRisk, seq = 2): SessionEvent =>
  event('task/risk-recorded', { risk }, seq)

const reviewed = (decision: string, seq = 3): SessionEvent =>
  event('task/review-decided', { decision }, seq)

const commitReceipt: TaskCommitReceipt = {
  kind: 'commit', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000001'),
  taskId: SessionId('root'), workspaceId: 'workspace' as TaskCommitReceipt['workspaceId'],
  reviewRevision: TaskReviewRevision('b'.repeat(64)), committedRevision: TaskReviewRevision('c'.repeat(64)),
  branch: 'dsh/task-0123456789abcdef01234567', commit: '1'.repeat(40), committedAt: 1_700_000_000_010,
}
const applyReceipt: TaskApplyReceipt = {
  kind: 'apply', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000002'),
  taskId: SessionId('root'), workspaceId: 'workspace' as TaskApplyReceipt['workspaceId'],
  reviewRevision: commitReceipt.committedRevision, commit: commitReceipt.commit,
  sourceHeadBefore: '2'.repeat(40), sourceHeadAfter: '2'.repeat(40), appliedAt: 1_700_000_000_011,
}
const discardReceipt: TaskDiscardReceipt = {
  kind: 'discard', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000003'),
  taskId: SessionId('root'), workspaceId: 'workspace' as TaskDiscardReceipt['workspaceId'],
  reviewRevision: commitReceipt.committedRevision, branch: commitReceipt.branch,
  branchPreserved: true, worktreeRemoved: true, uncommittedChangesDiscarded: false,
  recoverableCommit: commitReceipt.commit, discardedAt: 1_700_000_000_012,
}

const committed = (receipt: unknown = commitReceipt, seq = 4): SessionEvent =>
  event('task/review-committed', { receipt }, seq)
const applied = (receipt: unknown = applyReceipt, seq = 5): SessionEvent =>
  event('task/review-applied', { receipt }, seq)
const discarded = (receipt: unknown = discardReceipt, seq = 6): SessionEvent =>
  event('task/review-discarded', { receipt }, seq)

const assignment: TaskWorktreeAssignment = {
  kind: 'git-worktree',
  taskId: SessionId('root'),
  workspaceId: 'workspace' as TaskWorktreeAssignment['workspaceId'],
  sourcePath: 'D:\\repos\\source',
  path: 'D:\\harness\\worktrees\\root',
  branch: 'dsh/task-0123456789abcdef01234567',
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
  sourceHead: '0123456789abcdef0123456789abcdef01234567',
  sourceDirty: true,
  sourceStatusDigest: 'a'.repeat(64),
  createdAt: 1_700_000_000_000,
}

const worktreeAssigned = (value: unknown, seq = 0): SessionEvent =>
  event('task/worktree-assigned', { assignment: value }, seq)

function readyDeliveryPrefix(): SessionEvent[] {
  const criterion = { ...firstCriterion, status: 'satisfied' as const, evidence: [{ sessionId: SessionId('root'), seq: 1 }] }
  return [
    defined({ goal: 'Ship', criteria: [firstCriterion] }, 1),
    criterionUpdated(criterion, 2),
    reviewed('ready', 3),
  ]
}

describe('task replay fold', () => {
  it('starts empty and preserves identity for unrelated events', () => {
    const state = emptyTaskFoldState()
    expect(state).toEqual({
      assignment: undefined,
      definition: undefined,
      risks: [],
      reviewDecision: undefined,
      commitReceipt: undefined,
      applyReceipt: undefined,
      discardReceipt: undefined,
      updatedAt: undefined,
    })
    expect(applyTaskEvent(state, event('turn/start', { turn: 1 }, 0))).toBe(state)
  })

  it('replays one immutable worktree assignment as the task execution workspace', () => {
    const state = foldTask([worktreeAssigned(assignment)])

    expect(state.assignment).toEqual(assignment)
    expect(state.assignment).not.toBe(assignment)
    expect(state.updatedAt).toBe(1_700_000_000_000)
  })

  it.each([
    ['kind', { ...assignment, kind: 'directory' }, 'worktree kind must be git-worktree'],
    ['task id', { ...assignment, taskId: ' root ' }, 'worktree taskId must be non-empty and normalized'],
    ['workspace id', { ...assignment, workspaceId: '' }, 'worktree workspaceId must be non-empty and normalized'],
    ['source path', { ...assignment, sourcePath: ' source ' }, 'worktree sourcePath must be non-empty and normalized'],
    ['path', { ...assignment, path: '' }, 'worktree path must be non-empty and normalized'],
    ['branch', { ...assignment, branch: 'main' }, 'worktree branch is invalid'],
    ['base commit', { ...assignment, baseCommit: 'HEAD' }, 'worktree baseCommit must be a lowercase forty-character Git object id'],
    ['source head', { ...assignment, sourceHead: 'A'.repeat(40) }, 'worktree sourceHead must be a lowercase forty-character Git object id'],
    ['different heads', { ...assignment, sourceHead: '1'.repeat(40) }, 'worktree baseCommit must equal sourceHead'],
    ['dirty flag', { ...assignment, sourceDirty: 'yes' }, 'worktree sourceDirty must be boolean'],
    ['status digest', { ...assignment, sourceStatusDigest: 'a' }, 'worktree sourceStatusDigest must be a lowercase SHA-256 digest'],
    ['created time', { ...assignment, createdAt: -1 }, 'worktree createdAt must be a non-negative safe integer'],
    ['extra field', { ...assignment, extra: true }, 'worktree assignment must have exactly'],
  ])('rejects malformed persisted worktree data: %s', (_label, value, message) => {
    expect(() => foldTask([worktreeAssigned(value)])).toThrow(message)
  })

  it('rejects replacing an existing worktree assignment', () => {
    expect(() => foldTask([worktreeAssigned(assignment), worktreeAssigned(assignment, 1)]))
      .toThrow(/worktree assignment already exists/)
  })

  it('replaces definitions and detaches their ordered criteria', () => {
    const input = definition()
    const state = foldTask([
      defined(input),
      defined({ goal: 'Ship version two', criteria: [secondCriterion] }, 1),
    ])

    expect(state.definition).toEqual({ goal: 'Ship version two', criteria: [secondCriterion] })
    expect(state.updatedAt).toBe(1_700_000_000_001)
    expect(state.definition).not.toBe(input)
    expect(state.definition?.criteria).not.toBe(input.criteria)
  })

  it('updates a criterion in place without reordering siblings', () => {
    const satisfied: TaskCriterion = {
      ...firstCriterion,
      status: 'satisfied',
      evidence: [{ sessionId: SessionId('acceptance'), seq: 42 }],
    }
    const state = foldTask([defined(definition()), criterionUpdated(satisfied)])

    expect(state.definition?.criteria.map(item => item.id)).toEqual([
      TaskCriterionId('installer'),
      TaskCriterionId('parallel-agents'),
    ])
    expect(state.definition?.criteria[0]).toEqual(satisfied)
  })

  it('replaces risks by identity while preserving risk order and resolutions', () => {
    const first: TaskRisk = {
      id: TaskRiskId('signing'), severity: 'high', summary: 'Unsigned installer',
    }
    const second: TaskRisk = {
      id: TaskRiskId('update'), severity: 'medium', summary: 'Updater unavailable',
    }
    const resolved: TaskRisk = { ...first, resolution: 'Certificate configured' }
    const state = foldTask([
      riskRecorded(first, 0),
      riskRecorded(second, 1),
      riskRecorded(resolved, 2),
    ])

    expect(state.risks).toEqual([resolved, second])
  })

  it('accepts ready only after every criterion has evidence or is waived and risks are resolved', () => {
    const satisfied: TaskCriterion = {
      ...firstCriterion,
      status: 'satisfied',
      evidence: [{ sessionId: SessionId('acceptance'), seq: 7 }],
    }
    const waived: TaskCriterion = { ...secondCriterion, status: 'waived' }
    const risk: TaskRisk = {
      id: TaskRiskId('signing'),
      severity: 'high',
      summary: 'Unsigned installer',
      resolution: 'Certificate configured',
    }
    const state = foldTask([
      defined(definition()),
      criterionUpdated(satisfied),
      criterionUpdated(waived, 2),
      riskRecorded(risk, 3),
      reviewed('ready', 4),
    ])

    expect(state.reviewDecision).toBe('ready')
  })

  it.each([
    ['blank goal', defined({ goal: ' ', criteria: [firstCriterion] }, 8), 'goal must be non-empty and normalized'],
    ['empty criteria', defined({ goal: 'Ship', criteria: [] }, 8), 'criteria must contain at least one item'],
    ['duplicate criterion', defined({ goal: 'Ship', criteria: [firstCriterion, firstCriterion] }, 8), 'criterion ids must be unique'],
    ['missing criterion', criterionUpdated(firstCriterion, 8), 'criterion update requires a current definition'],
    ['satisfied without evidence', criterionUpdated({ ...firstCriterion, status: 'satisfied' }, 8), 'satisfied criterion requires evidence'],
    ['invalid evidence sequence', criterionUpdated({
      ...firstCriterion,
      status: 'satisfied',
      evidence: [{ sessionId: SessionId('acceptance'), seq: -1 }],
    }, 8), 'evidence seq must be a non-negative safe integer'],
    ['blank risk', riskRecorded({ id: TaskRiskId('r'), severity: 'high', summary: ' ' }, 8), 'risk summary must be non-empty and normalized'],
    ['unknown review', reviewed('approved', 8), 'review decision is invalid'],
  ])('rejects malformed persisted data: %s', (_label: string, candidate: SessionEvent, message: string) => {
    expect(() => foldTask([candidate])).toThrow(message)
  })

  it('rejects an update for an unknown criterion and an invalid terminal progression', () => {
    const unknown = { ...firstCriterion, id: TaskCriterionId('unknown') }
    expect(() => foldTask([defined(definition()), criterionUpdated(unknown)]))
      .toThrow(/criterion "unknown" does not exist/)
    expect(() => foldTask([defined(definition()), reviewed('ready')]))
      .toThrow(/ready requires every criterion to be satisfied or waived/)
    expect(() => foldTask([defined(definition()), reviewed('committed')]))
      .toThrow(/review decision is invalid/)
  })

  it('rejects forbidden criterion transitions', () => {
    const waived = { ...firstCriterion, status: 'waived' as const }
    const satisfied = {
      ...firstCriterion,
      status: 'satisfied' as const,
      evidence: [{ sessionId: SessionId('acceptance'), seq: 1 }],
    }
    expect(() => foldTask([
      defined(definition()),
      criterionUpdated(waived),
      criterionUpdated(satisfied, 2),
    ])).toThrow(/criterion transition waived -> satisfied is invalid/)
  })

  it.each([
    ['criterion status type', { ...firstCriterion, status: 1 }, 'criterion status is invalid'],
    ['criterion status value', { ...firstCriterion, status: 'done' }, 'criterion status is invalid'],
    ['criterion evidence container', { ...firstCriterion, evidence: null }, 'criterion evidence must be an array'],
    ['duplicate evidence', {
      ...firstCriterion,
      status: 'satisfied',
      evidence: [
        { sessionId: SessionId('acceptance'), seq: 1 },
        { sessionId: SessionId('acceptance'), seq: 1 },
      ],
    }, 'criterion evidence references must be unique'],
  ])('rejects malformed criterion fields: %s', (_label, criterion, message) => {
    expect(() => foldTask([
      defined(definition()),
      criterionUpdated(criterion as TaskCriterion),
    ])).toThrow(message)
  })

  it('requires definitions to contain canonical pending criteria', () => {
    expect(() => foldTask([defined({
      goal: 'Ship',
      criteria: [{
        ...firstCriterion,
        status: 'satisfied',
        evidence: [{ sessionId: SessionId('acceptance'), seq: 1 }],
      }],
    })])).toThrow(/defined criteria must start pending without evidence/)
    expect(() => foldTask([event('task/defined', {
      definition: { goal: 'Ship', criteria: null },
    }, 0)])).toThrow(/criteria must contain at least one item/)
  })

  it.each([
    ['non-record', null, 'risk must be a record'],
    ['severity type', { id: 'risk', severity: 1, summary: 'Unsafe' }, 'risk severity is invalid'],
    ['severity value', { id: 'risk', severity: 'urgent', summary: 'Unsafe' }, 'risk severity is invalid'],
  ])('rejects malformed risk fields: %s', (_label, risk, message) => {
    expect(() => foldTask([event('task/risk-recorded', { risk }, 0)])).toThrow(message)
  })

  it('enforces complete review progression and records whole delivery receipts', () => {
    const satisfied = {
      ...firstCriterion,
      status: 'satisfied' as const,
      evidence: [{ sessionId: SessionId('acceptance'), seq: 1 }],
    }
    const oneCriterion = { goal: 'Ship', criteria: [firstCriterion] }
    const readyPrefix = [defined(oneCriterion), criterionUpdated(satisfied)]
    expect(() => foldTask([...readyPrefix, riskRecorded({
      id: TaskRiskId('risk'), severity: 'high', summary: 'Unsafe',
    }), reviewed('ready')])).toThrow(/ready requires every risk to be resolved/)
    expect(() => foldTask([...readyPrefix, reviewed('ready'), committed()])).toThrow(/commit requires an assigned worktree/)
    expect(() => foldTask([worktreeAssigned(assignment), ...readyPrefix, applied()])).toThrow(/apply requires a recorded commit/)
    expect(() => foldTask([reviewed('changes-requested')])).toThrow(/changes-requested requires a current definition/)

    const state = foldTask([
      worktreeAssigned(assignment),
      ...readyPrefix,
      reviewed('ready'),
      committed(commitReceipt, 4),
      applied(applyReceipt, 5),
      discarded(discardReceipt, 6),
    ])
    expect(state).toMatchObject({ reviewDecision: 'ready', commitReceipt, applyReceipt, discardReceipt })
    expect(state.commitReceipt).not.toBe(commitReceipt)
    expect(foldTask([defined(oneCriterion), reviewed('changes-requested')]).reviewDecision)
      .toBe('changes-requested')
  })

  it.each([
    ['commit before ready', [worktreeAssigned(assignment), committed()], 'commit requires a ready decision'],
    ['mismatched task', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed({ ...commitReceipt, taskId: SessionId('other') })], 'commit receipt taskId does not match'],
    ['mismatched workspace', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed({ ...commitReceipt, workspaceId: 'other' })], 'commit receipt workspaceId does not match'],
    ['mismatched branch', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed({ ...commitReceipt, branch: 'dsh/task-aaaaaaaaaaaaaaaaaaaaaaaa' })], 'commit receipt branch does not match'],
    ['malformed review revision', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed({ ...commitReceipt, reviewRevision: 'bad' })], 'commit receipt reviewRevision must be a lowercase SHA-256 digest'],
    ['malformed operation id', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed({ ...commitReceipt, operationId: 'operation' })], 'commit receipt operationId must be a normalized UUID'],
    ['malformed commit', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed({ ...commitReceipt, commit: 'HEAD' })], 'commit receipt commit must be a lowercase forty-character Git object id'],
    ['duplicate commit', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed(), committed(commitReceipt, 5)], 'commit receipt already exists'],
    ['apply commit mismatch', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed(), applied({ ...applyReceipt, commit: '3'.repeat(40) })], 'apply receipt commit does not match'],
    ['apply revision mismatch', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed(), applied({ ...applyReceipt, reviewRevision: TaskReviewRevision('d'.repeat(64)) })], 'apply receipt reviewRevision does not match'],
    ['apply changed HEAD', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed(), applied({ ...applyReceipt, sourceHeadAfter: '3'.repeat(40) })], 'apply receipt must not change source HEAD'],
    ['discard without readiness', [worktreeAssigned(assignment), discarded(discardReceipt, 1)], 'discard requires a ready decision or recorded delivery'],
    ['discard missing removed flag', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), discarded({ ...discardReceipt, worktreeRemoved: false }, 4)], 'discard receipt must confirm worktree removal'],
    ['discard revision mismatch', [worktreeAssigned(assignment), ...readyDeliveryPrefix(), committed(), discarded({ ...discardReceipt, reviewRevision: TaskReviewRevision('d'.repeat(64)) }, 5)], 'discard receipt reviewRevision does not match'],
  ])('rejects forged delivery state: %s', (_label, events, message) => {
    expect(() => foldTask(events)).toThrow(message)
  })

  it('rejects a satisfied criterion becoming waived', () => {
    const satisfied = {
      ...firstCriterion,
      status: 'satisfied' as const,
      evidence: [{ sessionId: SessionId('acceptance'), seq: 1 }],
    }
    expect(() => foldTask([
      defined({ goal: 'Ship', criteria: [firstCriterion] }),
      criterionUpdated(satisfied),
      criterionUpdated({ ...firstCriterion, status: 'waived' }, 2),
    ])).toThrow(/criterion transition satisfied -> waived is invalid/)
  })

  it('exposes the failing event sequence on TaskLogError', () => {
    try {
      foldTask([defined({ goal: '', criteria: [firstCriterion] }, 19)])
      throw new Error('expected fold to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskLogError)
      expect((error as TaskLogError).seq).toBe(19)
    }
  })
})
