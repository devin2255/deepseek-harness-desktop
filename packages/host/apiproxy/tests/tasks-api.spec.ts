/** Host Task RPC forwarding, validation, error mapping, and change delivery. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import {
  TaskCriterionId, TaskError, TaskRiskId, TaskService,
} from '@deepseek-ai/dsh-task'
import type {
  AssignTaskWorktreeRequest, DefineTaskRequest, LiveTaskFact, RecordTaskApplyRequest, RecordTaskCommitRequest,
  RecordTaskDiscardRequest, RecordTaskRiskRequest, ReviewTaskRequest, TaskListChange,
  TaskListSnapshot, TaskSnapshot, UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import TaskReviewService, {
  TaskReviewError,
  TaskReviewOperationId,
  TaskReviewRevision,
  type ApplyTaskReviewRequest,
  type CommitTaskReviewRequest,
  type DiscardTaskReviewRequest,
  type GetTaskFileDiffRequest,
  type SummarizeTaskReviewRequest,
  type TaskApplyReceipt,
  type TaskCommitReceipt,
  type TaskDiscardReceipt,
  type TaskFileDiff,
  type TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  taskApplyRequestSchema, taskCommitRequestSchema, taskDefineRequestSchema, taskDiscardRequestSchema,
  taskListChangeSchema, taskReviewDiffRequestSchema, taskReviewSummaryRequestSchema, taskSnapshotSchema,
  taskUpdateCriterionRequestSchema,
} from '../src/api/tasks.schema.ts'

const rootId = SessionId('root')
const executionWorkspace: TaskWorktreeAssignment = {
  kind: 'git-worktree', taskId: rootId, workspaceId: 'workspace' as TaskWorktreeAssignment['workspaceId'],
  sourcePath: 'D:\\repos\\source', path: 'D:\\harness\\worktrees\\root',
  branch: 'dsh/task-0123456789abcdef01234567', baseCommit: '0'.repeat(40), sourceHead: '0'.repeat(40),
  sourceDirty: false, sourceStatusDigest: 'a'.repeat(64), createdAt: 1,
}
const row: TaskSnapshot = {
  taskId: rootId,
  descendantSessionIds: [],
  status: 'running',
  freshness: 'live',
  attention: [],
  risks: [],
  updatedAt: 10,
  asOfSeq: 2,
}
const reviewRow: TaskSnapshot = {
  ...row, workspaceId: executionWorkspace.workspaceId, executionWorkspace, status: 'ready', reviewDecision: 'ready',
}
const reviewRevision = TaskReviewRevision('b'.repeat(64))
const committedRevision = TaskReviewRevision('c'.repeat(64))
const commitReceipt: TaskCommitReceipt = {
  kind: 'commit', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000001'),
  taskId: rootId, workspaceId: executionWorkspace.workspaceId, reviewRevision, committedRevision,
  branch: executionWorkspace.branch, commit: '1'.repeat(40), committedAt: 20,
}
const applyReceipt: TaskApplyReceipt = {
  kind: 'apply', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000002'),
  taskId: rootId, workspaceId: executionWorkspace.workspaceId, reviewRevision: committedRevision,
  commit: commitReceipt.commit, sourceHeadBefore: '2'.repeat(40), sourceHeadAfter: '2'.repeat(40), appliedAt: 21,
}
const discardReceipt: TaskDiscardReceipt = {
  kind: 'discard', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000003'),
  taskId: rootId, workspaceId: executionWorkspace.workspaceId, reviewRevision: committedRevision,
  branch: executionWorkspace.branch, branchPreserved: true, worktreeRemoved: true,
  uncommittedChangesDiscarded: false, recoverableCommit: commitReceipt.commit, discardedAt: 22,
}
const reviewSummary: TaskReviewSummary = {
  taskId: rootId, workspaceId: executionWorkspace.workspaceId, revision: reviewRevision,
  baseCommit: executionWorkspace.baseCommit, headCommit: executionWorkspace.baseCommit,
  sourceHead: executionWorkspace.sourceHead, sourceDirty: false, branch: executionWorkspace.branch,
  dirty: true, truncated: false,
  files: [{ path: 'src/app.ts', status: 'modified', binary: false, additions: 2, deletions: 1 }],
  additions: 2, deletions: 1,
}
const fileDiff: TaskFileDiff = {
  taskId: rootId, workspaceId: executionWorkspace.workspaceId, revision: reviewRevision,
  path: 'src/app.ts', binary: false, truncated: false, patch: '@@ -1 +1 @@\n-old\n+new\n',
}

class FakeTaskReview extends TaskReviewService {
  last?: readonly [string, unknown, AbortSignal | undefined]
  nextError?: Error

  private result<T>(method: string, request: unknown, signal: AbortSignal | undefined, value: T): Promise<T> {
    this.last = [method, request, signal]
    return this.nextError === undefined ? Promise.resolve(value) : Promise.reject(this.nextError)
  }

  summarize(request: SummarizeTaskReviewRequest, signal?: AbortSignal): Promise<TaskReviewSummary> {
    return this.result('summarize', request, signal, reviewSummary)
  }

  diff(request: GetTaskFileDiffRequest, signal?: AbortSignal): Promise<TaskFileDiff> {
    return this.result('diff', request, signal, fileDiff)
  }

  commit(request: CommitTaskReviewRequest, signal?: AbortSignal): Promise<TaskCommitReceipt> {
    return this.result('commit', request, signal, commitReceipt)
  }

  apply(request: ApplyTaskReviewRequest, signal?: AbortSignal): Promise<TaskApplyReceipt> {
    return this.result('apply', request, signal, applyReceipt)
  }

  discard(request: DiscardTaskReviewRequest, signal?: AbortSignal): Promise<TaskDiscardReceipt> {
    return this.result('discard', request, signal, discardReceipt)
  }
}

class FakeTasks extends TaskService {
  readonly listeners = new Set<(change: TaskListChange) => void>()
  nextError?: Error
  last?: readonly [string, SessionId, unknown]
  live?: { generation: number; facts: readonly LiveTaskFact[] }
  invalidated?: number
  currentRow: TaskSnapshot = row

  snapshot(): TaskListSnapshot {
    return { generation: 4, tasks: [this.currentRow] }
  }

  onChanged(listener: (change: TaskListChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  replaceLiveGeneration(generation: number, facts: readonly LiveTaskFact[]): void {
    this.live = { generation, facts }
  }

  invalidateLiveGeneration(generation: number): void {
    this.invalidated = generation
  }

  emit(change: TaskListChange): void {
    for (const listener of this.listeners) listener(change)
  }

  assignWorktree(sessionId: SessionId, request: AssignTaskWorktreeRequest): Promise<TaskSnapshot> {
    return this.result('assignWorktree', sessionId, request)
  }

  private result(method: string, sessionId: SessionId, request: unknown): Promise<TaskSnapshot> {
    this.last = [method, sessionId, request]
    return this.nextError === undefined ? Promise.resolve(this.currentRow) : Promise.reject(this.nextError)
  }

  define(sessionId: SessionId, request: DefineTaskRequest): Promise<TaskSnapshot> {
    return this.result('define', sessionId, request)
  }

  updateCriterion(sessionId: SessionId, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot> {
    return this.result('updateCriterion', sessionId, request)
  }

  recordRisk(sessionId: SessionId, request: RecordTaskRiskRequest): Promise<TaskSnapshot> {
    return this.result('recordRisk', sessionId, request)
  }

  review(sessionId: SessionId, request: ReviewTaskRequest): Promise<TaskSnapshot> {
    return this.result('review', sessionId, request)
  }

  recordCommit(sessionId: SessionId, request: RecordTaskCommitRequest): Promise<TaskSnapshot> {
    return this.result('recordCommit', sessionId, request)
  }

  recordApply(sessionId: SessionId, request: RecordTaskApplyRequest): Promise<TaskSnapshot> {
    return this.result('recordApply', sessionId, request)
  }

  recordDiscard(sessionId: SessionId, request: RecordTaskDiscardRequest): Promise<TaskSnapshot> {
    return this.result('recordDiscard', sessionId, request)
  }
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('task-test'), payload }
}

async function harness(): Promise<{
  ctx: Context
  review: FakeTaskReview
  tasks: FakeTasks
  api: ReturnType<typeof createApiProxy>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FakeTasks)
  await ctx.plugin(FakeTaskReview)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  return {
    ctx,
    review: ctx.taskReview as FakeTaskReview,
    tasks: ctx.tasks as FakeTasks,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

describe('Task RPC', () => {
  it('publishes the host Agent registry as the complete live Task baseline', async () => {
    const { ctx, tasks } = await harness()
    let clock = 100
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock++)
    const session = ctx.sessions.create(rootId)
    const dispose = ctx.agents.register({ id: rootId, session, status: 'running', ctx } as Agent)

    expect(tasks.live).toMatchObject({
      generation: 4,
      facts: [{
        kind: 'activity',
        taskId: rootId,
        ownerSessionId: rootId,
        sourceId: `agent:${rootId}`,
        state: 'running',
      }],
    })
    const fact = tasks.live?.facts[0]
    expect(fact?.kind === 'activity' ? typeof fact.createdAt : undefined).toBe('number')
    const createdAt = fact?.kind === 'activity' ? fact.createdAt : undefined

    ctx.sessions.create(SessionId('unrelated'))
    expect(tasks.live?.facts[0]).toMatchObject({ kind: 'activity', createdAt })

    dispose()
    expect(tasks.live).toEqual({ generation: 4, facts: [] })
    now.mockRestore()
  })

  it('returns the service baseline and forwards all normalized mutations', async () => {
    const { api, tasks } = await harness()
    await expect(api.tasks.list(request({}))).resolves.toMatchObject({ result: { ok: true, value: { generation: 4, tasks: [row] } } })

    await api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [{ text: 'Passes' }], expectedSeq: 2 }))
    expect(tasks.last).toEqual(['define', rootId, { goal: 'Ship', criteria: [{ text: 'Passes' }], expectedSeq: 2 }])
    await api.tasks.updateCriterion(request({
      sessionId: rootId,
      criterion: { id: TaskCriterionId('criterion-1'), text: 'Passes', status: 'satisfied', evidence: [{ sessionId: rootId, seq: 2 }] },
      expectedSeq: 3,
    }))
    expect(tasks.last?.[0]).toBe('updateCriterion')
    await api.tasks.recordRisk(request({ sessionId: rootId, risk: { id: TaskRiskId('risk-1'), severity: 'high', summary: 'Signing' }, expectedSeq: 4 }))
    expect(tasks.last?.[0]).toBe('recordRisk')
    await api.tasks.review(request({ sessionId: rootId, decision: 'ready', expectedSeq: 5 }))
    expect(tasks.last).toEqual(['review', rootId, { decision: 'ready', expectedSeq: 5 }])
  })

  it('inspects and delivers the exact assigned Task review before recording receipts', async () => {
    const { api, review, tasks } = await harness()
    tasks.currentRow = reviewRow
    const signal = new AbortController().signal

    await expect(api.tasks.reviewSummary(request({ sessionId: rootId }), signal))
      .resolves.toMatchObject({ result: { ok: true, value: reviewSummary } })
    expect(review.last).toEqual(['summarize', { assignment: executionWorkspace }, signal])
    await expect(api.tasks.reviewDiff(request({
      sessionId: rootId, path: 'src/app.ts', expectedRevision: reviewRevision,
    }), signal)).resolves.toMatchObject({ result: { ok: true, value: fileDiff } })
    expect(review.last).toEqual([
      'diff', { assignment: executionWorkspace, path: 'src/app.ts', expectedRevision: reviewRevision }, signal,
    ])

    await api.tasks.commit(request({
      sessionId: rootId, expectedRevision: reviewRevision, message: 'feat: ship', expectedSeq: 2,
    }), signal)
    expect(review.last).toEqual([
      'commit', { assignment: executionWorkspace, expectedRevision: reviewRevision, message: 'feat: ship' }, signal,
    ])
    expect(tasks.last).toEqual(['recordCommit', rootId, { receipt: commitReceipt, expectedSeq: 2 }])

    tasks.currentRow = { ...reviewRow, status: 'settled', commitReceipt, asOfSeq: 3 }
    await api.tasks.apply(request({
      sessionId: rootId, expectedRevision: committedRevision, expectedSourceHead: '2'.repeat(40),
      commit: commitReceipt.commit, expectedSeq: 3,
    }), signal)
    expect(review.last).toEqual(['apply', {
      assignment: executionWorkspace,
      expectedRevision: committedRevision,
      expectedSourceHead: '2'.repeat(40),
      commit: commitReceipt.commit,
    }, signal])
    expect(tasks.last).toEqual(['recordApply', rootId, { receipt: applyReceipt, expectedSeq: 3 }])

    tasks.currentRow = { ...tasks.currentRow, applyReceipt, asOfSeq: 4 }
    await api.tasks.discard(request({
      sessionId: rootId, expectedRevision: committedRevision, confirmedUncommittedLoss: false, expectedSeq: 4,
    }), signal)
    expect(review.last).toEqual(['discard', {
      assignment: executionWorkspace, expectedRevision: committedRevision, confirmedUncommittedLoss: false,
    }, signal])
    expect(tasks.last).toEqual(['recordDiscard', rootId, { receipt: discardReceipt, expectedSeq: 4 }])
  })

  it('rejects direct-workspace and stale lifecycle requests before Git side effects', async () => {
    const { api, review, tasks } = await harness()
    tasks.currentRow = row
    await expect(api.tasks.reviewSummary(request({ sessionId: rootId }), new AbortController().signal))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-review-unavailable' } } })
    expect(review.last).toBeUndefined()

    tasks.currentRow = { ...reviewRow, status: 'reviewing' }
    await expect(api.tasks.commit(request({
      sessionId: rootId, expectedRevision: reviewRevision, message: 'feat: ship', expectedSeq: 2,
    }), new AbortController().signal)).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-invalid-review' } } })
    expect(review.last).toBeUndefined()
  })

  it('preserves cancellation and structured review failures without exposing native causes', async () => {
    const { api, review, tasks } = await harness()
    tasks.currentRow = reviewRow
    const controller = new AbortController()
    controller.abort()
    review.nextError = controller.signal.reason as Error
    await expect(api.tasks.reviewSummary(request({ sessionId: rootId }), controller.signal))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'cancelled' } } })

    const cause = new Error('git --secret-command D:\\private\\repository')
    review.nextError = new TaskReviewError(
      'The Task worktree changed after this review was loaded.', 'REVIEW_STALE', { cause },
    )
    const response = await api.tasks.reviewSummary(request({ sessionId: rootId }), new AbortController().signal)
    expect(response).toMatchObject({ result: { ok: false, error: {
      code: 'task-review-rejected',
      message: 'The Task worktree changed after this review was loaded.',
      details: { sessionId: rootId, reviewCode: 'REVIEW_STALE' },
    } } })
    expect(JSON.stringify(response)).not.toContain('secret-command')
    expect(JSON.stringify(response)).not.toContain('private')
  })

  it.each([
    ['TASK_NOT_FOUND', 'task-not-found'],
    ['TASK_TARGET_NOT_ROOT', 'task-target-not-root'],
    ['TASK_STALE_SEQUENCE', 'task-stale-sequence'],
    ['TASK_INVALID_DEFINITION', 'task-invalid-definition'],
    ['TASK_INVALID_CRITERION', 'task-invalid-criterion'],
    ['TASK_INVALID_RISK', 'task-invalid-risk'],
    ['TASK_INVALID_REVIEW', 'task-invalid-review'],
    ['TASK_INVALID_COMMIT', 'task-invalid-commit'],
    ['TASK_INVALID_APPLY', 'task-invalid-apply'],
    ['TASK_INVALID_DISCARD', 'task-invalid-discard'],
    ['TASK_INVALID_EVIDENCE', 'task-invalid-evidence'],
    ['TASK_INVALID_WORKTREE', 'task-invalid-worktree'],
    ['TASK_WORKTREE_ASSIGNED', 'task-worktree-assigned'],
    ['TASK_ACTIVE', 'task-active'],
    ['TASK_UNAVAILABLE', 'task-unavailable'],
  ] as const)('maps %s to %s', async (domainCode, wireCode) => {
    const { api, tasks } = await harness()
    tasks.nextError = new TaskError('rejected', domainCode)
    const response = await api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [], expectedSeq: 2 }))
    expect(response.result).toEqual({ ok: false, error: { code: wireCode, message: 'rejected', details: { sessionId: rootId } } })
  })

  it('reports an absent provider without throwing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    await expect(api.tasks.list(request({}))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [], expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.updateCriterion(request({ sessionId: rootId, criterion: { id: TaskCriterionId('c1'), text: 'Passes', status: 'pending', evidence: [] }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.recordRisk(request({ sessionId: rootId, risk: { id: TaskRiskId('r1'), severity: 'low', summary: 'Risk' }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.review(request({ sessionId: rootId, decision: 'ready', expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
  })

  it('maps failures from every mutation and contains unexpected provider errors', async () => {
    const { api, tasks } = await harness()
    tasks.nextError = new TaskError('stale', 'TASK_STALE_SEQUENCE')
    await expect(api.tasks.updateCriterion(request({ sessionId: rootId, criterion: { id: TaskCriterionId('c1'), text: 'Passes', status: 'pending', evidence: [] }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
    await expect(api.tasks.recordRisk(request({ sessionId: rootId, risk: { id: TaskRiskId('r1'), severity: 'low', summary: 'Risk' }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
    await expect(api.tasks.review(request({ sessionId: rootId, decision: 'ready', expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
    tasks.nextError = new Error('provider crashed')
    await expect(api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [], expectedSeq: 0 }))).resolves.toEqual({
      rpcId: RpcId('task-test'),
      result: { ok: false, error: { code: 'internal', message: 'Error: provider crashed', details: {} } },
    })
  })

  it('forwards changes on the host stream and disposes the provider subscription', async () => {
    const { api, tasks } = await harness()
    const abort = new AbortController()
    const iterator = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    expect(tasks.listeners.size).toBe(1)
    tasks.emit({ generation: 5, upserts: [row], removed: [] })
    const next = await pending
    expect(next.done).toBe(false)
    expect((next.value as RpcRequest<HostFrame>).payload).toEqual({ type: 'task/changed', generation: 5, upserts: [row], removed: [] })
    abort.abort()
    await iterator.next()
    expect(tasks.listeners.size).toBe(0)
  })
})

describe('Task wire schemas', () => {
  it('rejects unknown fields, blanks, negative sequences, and duplicate criterion ids', () => {
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [], expectedSeq: 0, extra: true }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: ' ', criteria: [], expectedSeq: 0 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [], expectedSeq: -1 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [{ id: 'same', text: 'A' }, { id: 'same', text: 'B' }], expectedSeq: 0 }).success).toBe(false)
  })

  it('rejects invalid evidence and malformed baseline or change discriminants', () => {
    const payload = {
      sessionId: 'root',
      criterion: { id: 'criterion-1', text: 'Passes', status: 'satisfied', evidence: [{ sessionId: 'root', seq: -1 }] },
      expectedSeq: 0,
    }
    expect(taskUpdateCriterionRequestSchema.safeParse(payload).success).toBe(false)
    expect(taskSnapshotSchema.safeParse({ ...row, status: 'waiting' }).success).toBe(false)
    expect(taskListChangeSchema.safeParse({ generation: -1, upserts: [], removed: [] }).success).toBe(false)
  })

  it('strictly validates all Task review and delivery requests', () => {
    expect(taskReviewSummaryRequestSchema.safeParse({ sessionId: 'root' }).success).toBe(true)
    expect(taskReviewDiffRequestSchema.safeParse({
      sessionId: 'root', path: '../secret', expectedRevision: reviewRevision,
    }).success).toBe(false)
    expect(taskCommitRequestSchema.safeParse({
      sessionId: 'root', expectedRevision: reviewRevision, message: ' ', expectedSeq: 2,
    }).success).toBe(false)
    expect(taskApplyRequestSchema.safeParse({
      sessionId: 'root', expectedRevision: committedRevision, expectedSourceHead: 'HEAD',
      commit: commitReceipt.commit, expectedSeq: 3,
    }).success).toBe(false)
    expect(taskDiscardRequestSchema.safeParse({
      sessionId: 'root', expectedRevision: committedRevision, confirmedUncommittedLoss: true, expectedSeq: -1,
    }).success).toBe(false)
  })

  it('validates complete definitions and rejects duplicate projected criterion identities', () => {
    const criterion = { id: 'criterion-1', text: 'Passes', status: 'pending', evidence: [] }
    expect(taskSnapshotSchema.safeParse({ ...row, definition: { goal: 'Ship', criteria: [criterion] } }).success).toBe(true)
    expect(taskSnapshotSchema.safeParse({
      ...row,
      definition: { goal: 'Ship', criteria: [criterion, { ...criterion, text: 'Duplicate' }] },
    }).success).toBe(false)
  })
})
