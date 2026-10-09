/** Host Task RPC forwarding, validation, error mapping, and change delivery. */

import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentOfflineReservationError } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import {
  TaskCriterionId, TaskError, TaskRiskId, TaskService,
} from '@deepseek-ai/dsh-task'
import type {
  AssignTaskWorktreeRequest, DefineTaskRequest, LiveTaskFact, RecordTaskApplyRequest, RecordTaskCommitRequest,
  RecordTaskDiscardRequest, RecordTaskRiskRequest, ReviewTaskRequest, TaskListChange,
  StartTaskDeliveryRequest, TaskListSnapshot, TaskSnapshot, UpdateTaskCriterionRequest,
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
  type IntegrateTaskReviewRequest,
  type TaskIntegrationResult,
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
  taskUpdateCriterionRequestSchema, taskRetryDeliveryCheckpointRequestSchema,
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
  integrate(_request: IntegrateTaskReviewRequest): Promise<TaskIntegrationResult> {
    throw new Error('This Host fixture does not expose writer integration.')
  }
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

  startDelivery(sessionId: SessionId, request: StartTaskDeliveryRequest): Promise<TaskSnapshot> {
    return this.result('startDelivery', sessionId, request)
  }

  retryDeliveryCheckpoint(sessionId: SessionId, operationId: TaskReviewOperationId): Promise<TaskSnapshot> {
    return this.result('retryDeliveryCheckpoint', sessionId, operationId)
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

type DeliveryMethod = 'commit' | 'apply' | 'discard'

function deliver(api: ReturnType<typeof createApiProxy>, method: DeliveryMethod, signal: AbortSignal) {
  switch (method) {
    case 'commit': return api.tasks.commit(request({
      sessionId: rootId, expectedRevision: reviewRevision, message: 'feat: deliver', expectedSeq: 2,
    }), signal)
    case 'apply': return api.tasks.apply(request({
      sessionId: rootId, expectedRevision: committedRevision, expectedSourceHead: '2'.repeat(40),
      commit: commitReceipt.commit, expectedSeq: 2,
    }), signal)
    case 'discard': return api.tasks.discard(request({
      sessionId: rootId, expectedRevision: committedRevision, confirmedUncommittedLoss: false, expectedSeq: 2,
    }), signal)
  }
}

describe('root delivery execution ownership', () => {
  it.each(['commit', 'apply', 'discard'] as const)('records %s authorization before accepting its correlated result', async (method) => {
    const { api, ctx, tasks, review } = await harness()
    tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
    const start = vi.spyOn(tasks, 'startDelivery')
    const record = vi.spyOn(tasks, method === 'commit' ? 'recordCommit' : method === 'apply' ? 'recordApply' : 'recordDiscard')
    const authorize = async <T>(request: CommitTaskReviewRequest | ApplyTaskReviewRequest | DiscardTaskReviewRequest, receipt: T) => {
      if ('confirmedUncommittedLoss' in request) await request.authorization!.authorize({ headCommit: commitReceipt.commit, uncommittedChanges: false })
      else await request.authorization!.authorize()
      expect(start).toHaveBeenCalledOnce()
      return { ...receipt, operationId: request.authorization!.operationId }
    }
    if (method === 'commit') vi.spyOn(review, 'commit').mockImplementation(request => authorize(request, commitReceipt))
    if (method === 'apply') vi.spyOn(review, 'apply').mockImplementation(request => authorize(request, applyReceipt))
    if (method === 'discard') vi.spyOn(review, 'discard').mockImplementation(request => authorize(request, discardReceipt))
    try {
      await expect(deliver(api, method, new AbortController().signal)).resolves.toMatchObject({ result: { ok: true } })
      expect(start.mock.calls[0]?.[1]).toMatchObject({ expectedSeq: reviewRow.asOfSeq, intent: {
        kind: method, operationId: record.mock.calls[0]?.[1].receipt.operationId,
      } })
      if (method === 'discard') expect(start.mock.calls[0]?.[1].intent).toMatchObject({
        headCommit: commitReceipt.commit, uncommittedChanges: false,
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('reports unconfirmed %s after Git, receipt, or cancellation failure', async (method) => {
    for (const phase of ['git-result', 'receipt', 'cancelled'] as const) {
      const { api, ctx, tasks, review } = await harness()
      tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
      const abort = new AbortController()
      const authorize = async <T>(request: CommitTaskReviewRequest | ApplyTaskReviewRequest | DiscardTaskReviewRequest, receipt: T) => {
        if ('confirmedUncommittedLoss' in request) await request.authorization!.authorize({ headCommit: commitReceipt.commit, uncommittedChanges: false })
        else await request.authorization!.authorize()
        if (phase === 'git-result') throw new TaskReviewError('Git response lost', 'REVIEW_STALE')
        if (phase === 'cancelled') { abort.abort(); abort.signal.throwIfAborted() }
        tasks.nextError = new TaskError('Receipt checkpoint failed', 'TASK_UNAVAILABLE')
        return { ...receipt, operationId: request.authorization!.operationId }
      }
      if (method === 'commit') vi.spyOn(review, 'commit').mockImplementation(request => authorize(request, commitReceipt))
      if (method === 'apply') vi.spyOn(review, 'apply').mockImplementation(request => authorize(request, applyReceipt))
      if (method === 'discard') vi.spyOn(review, 'discard').mockImplementation(request => authorize(request, discardReceipt))
      try {
        await expect(deliver(api, method, abort.signal)).resolves.toMatchObject({
          result: { ok: false, error: { code: 'task-delivery-pending', details: { sessionId: rootId } } },
        })
        const session = ctx.sessions.create(rootId)
        ctx.agents.enter({ id: rootId, session, status: 'idle', ctx } as Agent, undefined)()
      } finally {
        await ctx.fiber.dispose()
      }
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('keeps a cold root offline through %s and receipt settlement', async (method) => {
    const { api, ctx, tasks, review } = await harness()
    tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
    const entered = Promise.withResolvers<undefined>()
    const gitDone = Promise.withResolvers<undefined>()
    const recording = Promise.withResolvers<undefined>()
    const receiptDone = Promise.withResolvers<TaskSnapshot>()
    const hold = async <T>(receipt: T): Promise<T> => {
      entered.resolve(undefined)
      await gitDone.promise
      return receipt
    }
    if (method === 'commit') vi.spyOn(review, 'commit').mockImplementation(() => hold(commitReceipt))
    if (method === 'apply') vi.spyOn(review, 'apply').mockImplementation(() => hold(applyReceipt))
    if (method === 'discard') vi.spyOn(review, 'discard').mockImplementation(() => hold(discardReceipt))
    const record = method === 'commit' ? 'recordCommit' : method === 'apply' ? 'recordApply' : 'recordDiscard'
    vi.spyOn(tasks, record).mockImplementation(() => {
      recording.resolve(undefined)
      return receiptDone.promise
    })
    const session = ctx.sessions.create(rootId)
    const activation = () => ctx.agents.enter({ id: rootId, session, status: 'idle', ctx } as Agent, undefined)
    const pending = deliver(api, method, new AbortController().signal)
    try {
      await entered.promise
      expect(activation).toThrow(AgentOfflineReservationError)
      await expect(deliver(api, method, new AbortController().signal))
        .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-active' } } })
      gitDone.resolve(undefined)
      await recording.promise
      expect(activation).toThrow(AgentOfflineReservationError)
      const otherId = SessionId('independent-root')
      const other = ctx.sessions.create(otherId)
      ctx.agents.enter({ id: otherId, session: other, status: 'idle', ctx } as Agent, undefined)()
      receiptDone.resolve(tasks.currentRow)
      await expect(pending).resolves.toMatchObject({ result: { ok: true } })
      expect(ctx.agents.get(rootId)).toBeUndefined()
      activation()()
    } finally {
      gitDone.resolve(undefined)
      receiptDone.resolve(tasks.currentRow)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('releases a cold root after %s Provider or recording failure', async (method) => {
    const { api, ctx, tasks, review } = await harness()
    tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
    const session = ctx.sessions.create(rootId)
    try {
      review.nextError = new TaskReviewError('The reviewed tree changed.', 'REVIEW_STALE')
      await expect(deliver(api, method, new AbortController().signal))
        .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-review-rejected' } } })
      ctx.agents.enter({ id: rootId, session, status: 'idle', ctx } as Agent, undefined)()
      delete review.nextError
      tasks.nextError = new TaskError('Receipt could not be recorded.', 'TASK_STALE_SEQUENCE')
      await expect(deliver(api, method, new AbortController().signal))
        .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
      ctx.agents.enter({ id: rootId, session, status: 'idle', ctx } as Agent, undefined)()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('rejects busy resident %s before calling Git', async (method) => {
    const { api, ctx, tasks, review } = await harness()
    tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
    const session = ctx.sessions.create(rootId)
    try {
      for (const status of ['idle', 'running'] as const) {
        const busyAgent: Partial<Agent> = { id: rootId, session, status, ctx,
          runMaintenance<T>(): Promise<T> { throw new Error('Already executing or maintaining') },
        }
        const remove = ctx.agents.register(busyAgent as Agent)
        try {
          await expect(deliver(api, method, new AbortController().signal))
            .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-active' } } })
          expect(review.last).toBeUndefined()
          expect(tasks.last).toBeUndefined()
        } finally { remove() }
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('holds resident maintenance until %s receipt recording finishes', async (method) => {
    const { api, ctx, tasks, review } = await harness()
    tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
    const recording = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<TaskSnapshot>()
    let busy = false
    const agent = { id: rootId, session: ctx.sessions.create(rootId), status: 'idle', ctx,
      runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (busy) throw new Error('Maintenance is already owned')
        busy = true
        return job(new AbortController().signal).finally(() => { busy = false })
      },
    } as Agent
    ctx.agents.register(agent)
    const record = method === 'commit' ? 'recordCommit' : method === 'apply' ? 'recordApply' : 'recordDiscard'
    vi.spyOn(tasks, record).mockImplementation(() => { recording.resolve(undefined); return finish.promise })
    const signal = new AbortController().signal
    const pending = deliver(api, method, signal)
    try {
      await recording.promise
      expect(busy).toBe(true)
      expect(review.last?.[2]).not.toBe(signal)
      await expect(deliver(api, method, signal))
        .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-active' } } })
      finish.resolve(tasks.currentRow)
      await expect(pending).resolves.toMatchObject({ result: { ok: true } })
      expect(busy).toBe(false)
    } finally {
      finish.resolve(tasks.currentRow)
      await pending
      await ctx.fiber.dispose()
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('propagates both cancellation owners and awaits %s quiescence', async (method) => {
    for (const owner of ['agent', 'request'] as const) {
      const { api, ctx, tasks, review } = await harness()
      tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
      const agentAbort = new AbortController()
      const requestAbort = new AbortController()
      const entered = Promise.withResolvers<undefined>()
      const finish = Promise.withResolvers<undefined>()
      let busy = false
      const agent = { id: rootId, session: ctx.sessions.create(rootId), status: 'idle', ctx,
        runMaintenance<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T> {
          if (busy) throw new Error('Maintenance is already owned')
          busy = true
          return job(agentAbort.signal).finally(() => { busy = false })
        },
      } as Agent
      ctx.agents.register(agent)
      let providerSignal: AbortSignal | undefined
      vi.spyOn(review, method).mockImplementation(async (
        _request: CommitTaskReviewRequest | ApplyTaskReviewRequest | DiscardTaskReviewRequest, signal?: AbortSignal,
      ) => {
        providerSignal = signal
        entered.resolve(undefined)
        await finish.promise
        signal?.throwIfAborted()
        throw new Error('Expected cancellation')
      })
      const pending = deliver(api, method, requestAbort.signal)
      try {
        await entered.promise
        const abort = owner === 'agent' ? agentAbort : requestAbort
        abort.abort(new Error(`${owner} cancelled`))
        expect(providerSignal?.aborted).toBe(true)
        expect(busy).toBe(true)
        expect(tasks.last).toBeUndefined()
        await expect(deliver(api, method, new AbortController().signal))
          .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-active' } } })
        finish.resolve(undefined)
        await expect(pending).resolves.toMatchObject({ result: { ok: false, error: { code: 'cancelled' } } })
        expect(busy).toBe(false)
      } finally {
        finish.resolve(undefined)
        await pending
        await ctx.fiber.dispose()
      }
    }
  })

  it.each(['commit', 'apply', 'discard'] as const)('does not call %s after request cancellation', async (method) => {
    const { api, ctx, tasks, review } = await harness()
    tasks.currentRow = method === 'apply' ? { ...reviewRow, commitReceipt } : reviewRow
    const abort = new AbortController()
    abort.abort()
    try {
      await expect(deliver(api, method, abort.signal))
        .resolves.toMatchObject({ result: { ok: false, error: { code: 'cancelled' } } })
      expect(review.last).toBeUndefined()
      expect(tasks.last).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('Task RPC', () => {
  it('reads only a stopped direct writer from its own execution record without activating it', async () => {
    const { api, ctx, review, tasks } = await harness()
    tasks.currentRow = reviewRow
    const writerSessionId = SessionId('writer')
    const assignment = { ...executionWorkspace, taskId: writerSessionId, sourcePath: executionWorkspace.path, path: resolve('writer-test') }
    const child = ctx.sessions.create(writerSessionId, { meta: { origin: 'subagent', parentSession: rootId, cwd: assignment.path } })
    child.append('subagent/worktree-assigned', { parentTaskId: rootId, assignment })
    vi.spyOn(review, 'summarize').mockResolvedValue({ ...reviewSummary, taskId: writerSessionId })
    const signal = new AbortController().signal
    await expect(api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), signal))
      .resolves.toMatchObject({ result: { ok: true, value: { taskId: writerSessionId } } })
    expect(review.last).toBeUndefined()
    await api.tasks.reviewDiff(request({ sessionId: rootId, writerSessionId, path: 'src/app.ts', expectedRevision: reviewRevision }), signal)
    expect(review.last).toEqual(['diff', { assignment, path: 'src/app.ts', expectedRevision: reviewRevision }, signal])
    expect(ctx.agents.get(writerSessionId)).toBeUndefined()

    const remove = ctx.agents.register({ id: writerSessionId, session: child, status: 'idle', ctx } as Agent)
    delete review.last
    await expect(api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), signal))
      .resolves.toMatchObject({ result: { ok: false, error: { details: { reviewCode: 'REVIEW_STALE' } } } })
    expect(review.last).toBeUndefined()
    remove()
    await ctx.fiber.dispose()
  })

  it('rejects foreign, shared, inherited, and discarded writer selections before Git inspection', async () => {
    const { api, ctx, review, tasks } = await harness()
    tasks.currentRow = reviewRow
    const signal = new AbortController().signal
    for (const [id, parentSession, seedLength, assigned] of [
      ['foreign', SessionId('other'), 0, true], ['shared', rootId, 0, false], ['inherited', rootId, 1, true],
    ] as const) {
      const writerSessionId = SessionId(id)
      const assignment = { ...executionWorkspace, taskId: writerSessionId, sourcePath: executionWorkspace.path, path: resolve(`${id}-test`) }
      const child = ctx.sessions.create(writerSessionId, {
        meta: { origin: 'subagent', parentSession, seedLength, cwd: assignment.path },
        ...seedLength === 0 ? {} : { seed: [{ type: 'subagent/worktree-assigned', seq: 0, time: 1, data: { parentTaskId: rootId, assignment } }] },
      })
      if (assigned && seedLength === 0) child.append('subagent/worktree-assigned', { parentTaskId: rootId, assignment })
      await expect(api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), signal))
        .resolves.toMatchObject({ result: { ok: false, error: { details: { reviewCode: 'REVIEW_INVALID_INTEGRATION' } } } })
    }
    tasks.currentRow = { ...reviewRow, discardReceipt }
    await expect(api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId: SessionId('missing') }), signal))
      .resolves.toMatchObject({ result: { ok: false, error: { details: { reviewCode: 'REVIEW_WORKTREE_UNAVAILABLE' } } } })
    expect(review.last).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps a cold writer offline throughout inspection and rejects competing reads', async () => {
    const { api, ctx, review, tasks } = await harness()
    tasks.currentRow = reviewRow
    const writerSessionId = SessionId('cold-writer')
    const assignment = { ...executionWorkspace, taskId: writerSessionId, sourcePath: executionWorkspace.path, path: resolve('cold-writer-test') }
    const meta = ctx.sessions.prepare(writerSessionId, { meta: { origin: 'subagent', parentSession: rootId, cwd: assignment.path } }).header
    const events = [{ type: 'subagent/worktree-assigned' as const, seq: 0, time: 1, data: { parentTaskId: rootId, assignment } }]
    const inspect = vi.fn(async () => ({ meta, events }))
    ctx.provide('sessionPersistence', { inspect } as never)
    const signal = new AbortController().signal
    await api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), signal)
    expect(inspect).toHaveBeenCalledWith(writerSessionId, signal)
    expect(review.last?.[1]).toEqual({ assignment })
    expect(ctx.agents.get(writerSessionId)).toBeUndefined()
    delete review.last
    inspect.mockImplementation(async () => {
      const prepared = ctx.sessions.prepare(writerSessionId, { meta })
      expect(() => ctx.agents.enter({ id: writerSessionId, session: prepared, ctx } as Agent, undefined))
        .toThrow(AgentOfflineReservationError)
      await expect(api.tasks.reviewDiff(request({ sessionId: rootId, writerSessionId, path: 'src/app.ts', expectedRevision: reviewRevision }), signal))
        .resolves.toMatchObject({ result: { ok: false, error: { details: { reviewCode: 'REVIEW_STALE' } } } })
      return { meta, events }
    })
    await expect(api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), signal))
      .resolves.toMatchObject({ result: { ok: true } })
    expect(review.last?.[1]).toEqual({ assignment })
    expect(ctx.agents.get(writerSessionId)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it.each(['summary', 'diff'] as const)('holds the writer through the complete %s Provider read and releases every outcome', async (method) => {
    const { api, ctx, review, tasks } = await harness()
    tasks.currentRow = reviewRow
    const writerSessionId = SessionId('provider-writer')
    const assignment = { ...executionWorkspace, taskId: writerSessionId, sourcePath: executionWorkspace.path, path: resolve('provider-writer-test') }
    const child = ctx.sessions.create(writerSessionId, { meta: { origin: 'subagent', parentSession: rootId, cwd: assignment.path } })
    child.append('subagent/worktree-assigned', { parentTaskId: rootId, assignment })
    for (const outcome of ['success', 'failure', 'cancelled'] as const) {
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const abort = new AbortController()
      const gate = async (): Promise<void> => {
        entered.resolve(undefined)
        await release.promise
        abort.signal.throwIfAborted()
        if (outcome === 'failure') throw new TaskReviewError('Git read failed.', 'REVIEW_GIT_FAILED')
      }
      const summary = vi.spyOn(review, 'summarize').mockImplementation(async () => { await gate(); return reviewSummary })
      const diff = vi.spyOn(review, 'diff').mockImplementation(async () => { await gate(); return fileDiff })
      const pending = method === 'summary'
        ? api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), abort.signal)
        : api.tasks.reviewDiff(request({ sessionId: rootId, writerSessionId, path: 'src/app.ts', expectedRevision: reviewRevision }), abort.signal)
      try {
        await entered.promise
        expect(() => ctx.agents.enter({ id: writerSessionId, session: child, ctx } as Agent, undefined))
          .toThrow(AgentOfflineReservationError)
        await expect(api.tasks.reviewSummary(request({ sessionId: rootId, writerSessionId }), new AbortController().signal))
          .resolves.toMatchObject({ result: { ok: false, error: { details: { reviewCode: 'REVIEW_STALE' } } } })
        if (outcome === 'cancelled') abort.abort()
        release.resolve(undefined)
        const response = await pending
        expect(response.result.ok).toBe(outcome === 'success')
        if (outcome === 'cancelled') expect(response).toMatchObject({ result: { error: { code: 'cancelled' } } })
        const remove = ctx.agents.enter({ id: writerSessionId, session: child, ctx } as Agent, undefined)
        remove()
      } finally {
        release.resolve(undefined)
        await pending
        summary.mockRestore()
        diff.mockRestore()
      }
    }
    await ctx.fiber.dispose()
  })

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
    const operationId = TaskReviewOperationId('00000000-0000-4000-8000-000000000001')
    await api.tasks.retryDeliveryCheckpoint(request({ sessionId: rootId, operationId }))
    expect(tasks.last).toEqual(['retryDeliveryCheckpoint', rootId, operationId])
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
    expect(review.last).toMatchObject([
      'commit', { assignment: executionWorkspace, expectedRevision: reviewRevision, message: 'feat: ship' }, signal,
    ])
    expect(tasks.last).toEqual(['recordCommit', rootId, { receipt: commitReceipt }])

    tasks.currentRow = { ...reviewRow, status: 'settled', commitReceipt, asOfSeq: 3 }
    await api.tasks.apply(request({
      sessionId: rootId, expectedRevision: committedRevision, expectedSourceHead: '2'.repeat(40),
      commit: commitReceipt.commit, expectedSeq: 3,
    }), signal)
    expect(review.last).toMatchObject(['apply', {
      assignment: executionWorkspace,
      expectedRevision: committedRevision,
      expectedSourceHead: '2'.repeat(40),
      commit: commitReceipt.commit,
    }, signal])
    expect(tasks.last).toEqual(['recordApply', rootId, { receipt: applyReceipt }])

    tasks.currentRow = { ...tasks.currentRow, applyReceipt, asOfSeq: 4 }
    await api.tasks.discard(request({
      sessionId: rootId, expectedRevision: committedRevision, confirmedUncommittedLoss: false, expectedSeq: 4,
    }), signal)
    expect(review.last).toMatchObject(['discard', {
      assignment: executionWorkspace, expectedRevision: committedRevision, confirmedUncommittedLoss: false,
    }, signal])
    expect(tasks.last).toEqual(['recordDiscard', rootId, { receipt: discardReceipt }])
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
    await expect(api.tasks.retryDeliveryCheckpoint(request({ sessionId: rootId,
      operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000001') })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
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

  it('maps checkpoint failures without requiring TaskReview or an existing worktree', async () => {
    const { api, tasks } = await harness()
    const operationId = TaskReviewOperationId('00000000-0000-4000-8000-000000000001')
    tasks.nextError = new TaskError('Receipt unavailable', 'TASK_DELIVERY_PENDING')
    await expect(api.tasks.retryDeliveryCheckpoint(request({ sessionId: rootId, operationId })))
      .resolves.toMatchObject({ result: { ok: false, error: { code: 'task-delivery-pending' } } })
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
  it('requires a retryable checkpoint to match root-owned unconfirmed attention', () => {
    const operationId = '00000000-0000-4000-8000-000000000001'
    const item = { id: 'pending', taskId: rootId, ownerSessionId: rootId, kind: 'delivery-unconfirmed',
      severity: 'error', summary: 'Save receipt', createdAt: 1, sourceId: operationId, actionable: true }
    const value = { ...row, retryableDeliveryCheckpoint: operationId, attention: [item] }
    expect(taskSnapshotSchema.safeParse(value).success).toBe(true)
    for (const invalid of [
      { ...value, retryableDeliveryCheckpoint: 'invalid' },
      { ...value, attention: [] },
      { ...value, attention: [{ ...item, kind: 'review-request' }] },
      { ...value, attention: [{ ...item, ownerSessionId: 'child' }] },
      { ...value, attention: [{ ...item, sourceId: 'different' }] },
    ]) expect(taskSnapshotSchema.safeParse(invalid).success).toBe(false)
    expect(taskRetryDeliveryCheckpointRequestSchema.safeParse({ sessionId: rootId, operationId }).success).toBe(true)
    for (const invalid of [
      { sessionId: rootId, operationId: 'invalid' }, { sessionId: rootId, operationId, extra: true },
      { sessionId: ' ', operationId },
    ]) expect(taskRetryDeliveryCheckpointRequestSchema.safeParse(invalid).success).toBe(false)
  })

  it('accepts the SDK history fixture and rejects the same malformed relationships and fields', () => {
    const fixture = new URL('../../../../scripts/snapshots/task-integration-sdk/task.json', import.meta.url)
    const value = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>
    const invalid = JSON.parse(readFileSync(new URL('../../../../scripts/snapshots/task-integration-sdk/invalid.json', import.meta.url), 'utf8')) as {
      name: string
      path: string
      value: unknown
    }[]
    expect(taskSnapshotSchema.safeParse(value).success).toBe(true)
    for (const change of invalid) {
      const modified = structuredClone(value)
      const keys = change.path.split('/')
      let target = modified
      for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
      target[keys.at(-1)!] = change.value
      expect(taskSnapshotSchema.safeParse(modified).success, change.name).toBe(false)
    }
  })

  it('validates integration receipts against the owning root, call sequence, and selected descendants', () => {
    const receipt = { kind: 'integrated', operationId: '00000000-0000-4000-8000-000000000001', taskId: rootId,
      workspaceId: executionWorkspace.workspaceId, reviewRevision, headBefore: '0'.repeat(40), headAfter: '1'.repeat(40), integratedAt: 2,
      contributors: [{ sessionId: 'writer', branch: 'writer', commit: '2'.repeat(40), reviewRevision }] }
    const node = { id: 'root:integration:1', callSeq: 1, startedAt: 1, finishedAt: 2, writerSessionIds: ['writer'],
      outcome: { kind: 'integrated', result: receipt } }
    const value = { ...reviewRow, descendantSessionIds: ['writer'], integrations: [node] }
    expect(taskSnapshotSchema.safeParse(value).success).toBe(true)
    for (const invalid of [
      { ...value, integrations: [] }, { ...value, taskId: 'other' }, { ...value, descendantSessionIds: [] },
      { ...value, integrations: [{ ...node, id: 'other:integration:1' }] },
      { ...value, integrations: [{ ...node, callSeq: 2 }] },
      { ...value, integrations: [{ ...node, resolvedBy: 'fake' }] },
      { ...value, integrations: [{ ...node, outcome: { kind: 'integrated', result: { ...receipt, taskId: 'other' } } }] },
      { ...value, integrations: [{ ...node, outcome: { kind: 'integrated', result: { ...receipt, unexpected: true } } }] },
    ]) expect(taskSnapshotSchema.safeParse(invalid).success).toBe(false)
  })

  it('rejects unknown fields, blanks, negative sequences, and duplicate criterion ids', () => {
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [], expectedSeq: 0, extra: true }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: ' ', criteria: [], expectedSeq: 0 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [], expectedSeq: -1 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [{ id: 'same', text: 'A' }, { id: 'same', text: 'B' }], expectedSeq: 0 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [{ text: 'Choose later' }], expectedSeq: 0 }).success).toBe(true)
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
    expect(taskReviewSummaryRequestSchema.safeParse({ sessionId: 'root', writerSessionId: 'writer' }).success).toBe(true)
    expect(taskReviewSummaryRequestSchema.safeParse({ sessionId: 'root', writerSessionId: ' writer ' }).success).toBe(false)
    expect(taskReviewDiffRequestSchema.safeParse({ sessionId: 'root', writerSessionId: 1, path: 'a.txt', expectedRevision: reviewRevision }).success).toBe(false)
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

  it('rejects mismatched worktree identities and an Apply receipt that moves source HEAD', () => {
    expect(taskSnapshotSchema.safeParse({ ...reviewRow, taskId: 'other-task' }).success).toBe(false)
    expect(taskSnapshotSchema.safeParse({ ...reviewRow, workspaceId: 'other-workspace' }).success).toBe(false)
    expect(taskSnapshotSchema.safeParse({ ...reviewRow, applyReceipt: {
      ...applyReceipt, sourceHeadAfter: '3'.repeat(40),
    } }).success).toBe(false)
  })
})
