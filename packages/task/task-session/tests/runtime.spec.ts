import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { Session, SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  AttentionItemId,
  TaskCriterionId,
  TaskError,
  TaskRiskId,
  type LiveTaskFact,
} from '@deepseek-ai/dsh-task'
import TaskSessionProvider from '../src/index.ts'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import {
  TaskReviewOperationId,
  TaskReviewRevision,
  type TaskApplyReceipt,
  type TaskCommitReceipt,
  type TaskDiscardReceipt,
} from '@deepseek-ai/dsh-task-review'

const sid = SessionId
const assignment = (taskId = sid('root'), workspaceId = 'workspace' as TaskWorktreeAssignment['workspaceId']): TaskWorktreeAssignment => ({
  kind: 'git-worktree', taskId, workspaceId,
  sourcePath: 'D:\\repos\\source', path: 'D:\\harness\\worktrees\\root',
  branch: 'dsh/task-0123456789abcdef01234567',
  baseCommit: '0123456789abcdef0123456789abcdef01234567',
  sourceHead: '0123456789abcdef0123456789abcdef01234567', sourceDirty: false,
  sourceStatusDigest: 'a'.repeat(64), createdAt: 1,
})
const commitReceipt = (): TaskCommitReceipt => ({
  kind: 'commit', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000001'),
  taskId: sid('root'), workspaceId: 'workspace' as TaskCommitReceipt['workspaceId'],
  reviewRevision: TaskReviewRevision('b'.repeat(64)), committedRevision: TaskReviewRevision('c'.repeat(64)),
  branch: assignment().branch, commit: '1'.repeat(40), committedAt: 10,
})
const applyReceipt = (): TaskApplyReceipt => ({
  kind: 'apply', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000002'),
  taskId: sid('root'), workspaceId: 'workspace' as TaskApplyReceipt['workspaceId'],
  reviewRevision: commitReceipt().committedRevision, commit: commitReceipt().commit,
  sourceHeadBefore: '2'.repeat(40), sourceHeadAfter: '2'.repeat(40), appliedAt: 11,
})
const discardReceipt = (): TaskDiscardReceipt => ({
  kind: 'discard', operationId: TaskReviewOperationId('00000000-0000-4000-8000-000000000003'),
  taskId: sid('root'), workspaceId: 'workspace' as TaskDiscardReceipt['workspaceId'],
  reviewRevision: commitReceipt().committedRevision, branch: assignment().branch,
  branchPreserved: true, worktreeRemoved: true, uncommittedChangesDiscarded: false,
  recoverableCommit: commitReceipt().commit, discardedAt: 12,
})
function persistence(initial: readonly { header: SessionHeader; events: readonly SessionEvent[] }[] = []) {
  const logs = new Map(initial.map(item => [item.header.id, { meta: item.header, events: [...item.events] }]))
  const append = vi.fn(async (id: ReturnType<typeof sid>, events: readonly SessionEvent[]) => {
    const found = logs.get(id)
    if (found === undefined) throw new Error('missing')
    if (events[0]?.seq !== found.events.length) throw new Error('stale')
    found.events.push(...events)
  })
  return {
    logs,
    service: {
      listSnapshots: async () => [...logs.values()].map(value => ({ header: value.meta, revision: 'r' })),
      inspect: async (id: ReturnType<typeof sid>) => {
        const found = logs.get(id)
        if (found === undefined) throw new Error('missing')
        return { meta: found.meta, events: [...found.events] }
      },
      append,
    },
    append,
  }
}

async function harness(initial: readonly { header: SessionHeader; events: readonly SessionEvent[] }[] = []) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const persisted = persistence(initial)
  ctx.provide('sessionPersistence', persisted.service as never)
  const fiber = await ctx.plugin(TaskSessionProvider)
  return { ctx, fiber, persisted, tasks: ctx.tasks as TaskSessionProvider }
}

const question = (generation: number, sourceId: string): { generation: number; facts: LiveTaskFact[] } => ({
  generation,
  facts: [{
    kind: 'attention',
    item: {
      id: AttentionItemId(`root:${sourceId}`), taskId: sid('root'), ownerSessionId: sid('root'), kind: 'question',
      severity: 'warning', summary: sourceId, createdAt: generation, sourceId, actionable: true,
    },
  }],
})

describe('TaskSessionProvider', () => {
  it('reconstructs cold and live Session logs without resuming an Agent', async () => {
    const cold = Session.create(sid('cold'))
    cold.append('task/defined', { definition: { goal: 'cold task', criteria: [
      { id: TaskCriterionId('done'), text: 'done', status: 'pending', evidence: [] },
    ] } })
    const test = await harness([{ header: cold.header, events: cold.events }])
    const live = test.ctx.sessions.create(sid('live'))
    live.append('task/defined', { definition: { goal: 'live task', criteria: [
      { id: TaskCriterionId('done'), text: 'done', status: 'pending', evidence: [] },
    ] } })
    expect(new Set(test.tasks.snapshot().tasks.map(task => task.taskId))).toEqual(new Set([sid('cold'), sid('live')]))
  })

  it('adopts Sessions that were already live before the Provider initialized', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create(sid('existing'))
    const persisted = persistence()
    ctx.provide('sessionPersistence', persisted.service as never)
    await ctx.plugin(TaskSessionProvider)
    expect(ctx.tasks.snapshot().tasks.map(task => task.taskId)).toEqual([sid('existing')])
  })

  it('publishes generation baselines, retains disconnected facts, and ignores stale replacement', async () => {
    const test = await harness()
    test.ctx.sessions.create(sid('root'))
    const first = question(2, 'new')
    test.tasks.replaceLiveGeneration(first.generation, first.facts)
    test.tasks.invalidateLiveGeneration(2)
    expect(test.tasks.snapshot()).toMatchObject({ generation: 2, tasks: [{ freshness: 'disconnected', attention: [{ sourceId: 'new' }] }] })
    const stale = question(2, 'stale')
    test.tasks.replaceLiveGeneration(stale.generation, stale.facts)
    expect(test.tasks.snapshot().tasks[0]?.attention[0]?.sourceId).toBe('new')
    const next = question(3, 'next')
    test.tasks.replaceLiveGeneration(next.generation, next.facts)
    expect(test.tasks.snapshot()).toMatchObject({ generation: 3, tasks: [{ freshness: 'live', attention: [{ sourceId: 'next' }] }] })
    test.tasks.replaceLiveGeneration(1, question(1, 'older').facts)
    test.tasks.invalidateLiveGeneration(1)
    test.tasks.invalidateLiveGeneration(3)
    expect(() => { test.tasks.replaceLiveGeneration(-1, []) }).toThrow(/non-negative safe integer/)
    expect(() => { test.tasks.replaceLiveGeneration(1.5, []) }).toThrow(/non-negative safe integer/)
  })

  it('settles one live source without clearing its sibling', async () => {
    const test = await harness()
    test.ctx.sessions.create(sid('root'))
    const first = question(1, 'q1').facts[0]
    const second = question(1, 'a1').facts[0]
    test.tasks.replaceLiveGeneration(1, [first!, second!])
    test.tasks.replaceLiveGeneration(1, [second!])
    expect(test.tasks.snapshot().tasks[0]?.attention.map(item => item.sourceId)).toEqual(['a1'])
  })

  it('contains listener failures and delivers the same committed row to siblings', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    const later = vi.fn()
    test.tasks.onChanged(() => { throw new Error('broken listener') })
    test.tasks.onChanged(later)
    await test.tasks.define(root.id, { goal: 'ship', criteria: [{ text: 'works' }], expectedSeq: 0 })
    expect(later).toHaveBeenCalledOnce()
    expect(later.mock.calls[0]?.[0]).toMatchObject({ upserts: [{ definition: { goal: 'ship' } }] })
    const stop = test.tasks.onChanged(later)
    stop()
    test.tasks.replaceLiveGeneration(4, [])
  })

  it('uses compare-and-set and appends exactly one validated event to a live root', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    const defined = await test.tasks.define(root.id, { goal: 'ship', criteria: [{ id: TaskCriterionId('done'), text: 'works' }], expectedSeq: 0 })
    expect(root.events).toHaveLength(1)
    await test.tasks.updateCriterion(root.id, {
      criterion: { id: TaskCriterionId('done'), text: 'works', status: 'satisfied', evidence: [{ sessionId: root.id, seq: 0 }] },
      expectedSeq: 1,
    })
    expect(root.events).toHaveLength(2)
    await expect(test.tasks.define(root.id, { goal: 'again', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_STALE_SEQUENCE' })
    expect(defined).toMatchObject({ asOfSeq: 1, definition: { goal: 'ship' } })
  })

  it('assigns one durable execution worktree and restores it through the Task projection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persisted = persistence()
    ctx.provide('sessionPersistence', persisted.service as never)
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === 'workspace' ? { id, path: 'D:\\repos\\source', sessionIds: [sid('root')] } : undefined,
      list: () => [{ id: 'workspace', path: 'D:\\repos\\source', sessionIds: [sid('root')] }],
    } as never)
    await ctx.plugin(TaskSessionProvider)
    const root = ctx.sessions.create(sid('root'))

    const result = await ctx.tasks.assignWorktree(root.id, { assignment: assignment(), expectedSeq: 0 })

    expect(root.events).toMatchObject([{ type: 'task/worktree-assigned', data: { assignment: assignment() } }])
    expect(result).toMatchObject({ workspaceId: 'workspace', executionWorkspace: assignment(), asOfSeq: 1 })
    await expect(ctx.tasks.assignWorktree(root.id, { assignment: assignment(), expectedSeq: 1 }))
      .rejects.toMatchObject({ code: 'TASK_WORKTREE_ASSIGNED' })
  })

  it('rejects invalid worktree ownership before appending', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persisted = persistence()
    ctx.provide('sessionPersistence', persisted.service as never)
    ctx.provide('workspaceRegistry', {
      get: (id: string) => id === 'workspace' ? { id, path: 'D:\\repos\\source', sessionIds: [sid('root')] } : undefined,
      list: () => [{ id: 'workspace', path: 'D:\\repos\\source', sessionIds: [sid('root')] }],
    } as never)
    await ctx.plugin(TaskSessionProvider)
    const root = ctx.sessions.create(sid('root'))
    const child = ctx.sessions.create(sid('child'), { meta: { origin: 'subagent', parentSession: root.id } })

    await expect(ctx.tasks.assignWorktree(root.id, { assignment: assignment(sid('other')), expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_INVALID_WORKTREE' })
    await expect(ctx.tasks.assignWorktree(root.id, { assignment: assignment(root.id, 'missing' as never), expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_INVALID_WORKTREE' })
    await expect(ctx.tasks.assignWorktree(root.id, {
      assignment: { ...assignment(), sourcePath: 'D:\\repos\\other' }, expectedSeq: 0,
    })).rejects.toMatchObject({ code: 'TASK_INVALID_WORKTREE' })
    await expect(ctx.tasks.assignWorktree(child.id, { assignment: assignment(child.id), expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_TARGET_NOT_ROOT' })
    expect(root.events).toEqual([])
  })

  it('updates a cold root through persistence and rejects foreign or missing evidence', async () => {
    const cold = Session.create(sid('root'))
    cold.append('task/defined', { definition: { goal: 'ship', criteria: [
      { id: TaskCriterionId('done'), text: 'works', status: 'pending', evidence: [] },
    ] } })
    const test = await harness([{ header: cold.header, events: cold.events }])
    await test.tasks.updateCriterion(sid('root'), {
      criterion: { id: TaskCriterionId('done'), text: 'works', status: 'satisfied', evidence: [{ sessionId: sid('root'), seq: 0 }] },
      expectedSeq: 1,
    })
    expect(test.persisted.append).toHaveBeenCalledOnce()
    await expect(test.tasks.updateCriterion(sid('root'), {
      criterion: { id: TaskCriterionId('done'), text: 'works', status: 'satisfied', evidence: [{ sessionId: sid('foreign'), seq: 0 }] },
      expectedSeq: 2,
    })).rejects.toMatchObject({ code: 'TASK_INVALID_EVIDENCE' })
    await expect(test.tasks.updateCriterion(sid('root'), {
      criterion: { id: TaskCriterionId('done'), text: 'works', status: 'satisfied', evidence: [{ sessionId: sid('root'), seq: 99 }] },
      expectedSeq: 2,
    })).rejects.toMatchObject({ code: 'TASK_INVALID_EVIDENCE' })
  })

  it('records risks and review decisions through their exact live event variants', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    await test.tasks.define(root.id, { goal: 'ship', criteria: [{ id: TaskCriterionId('done'), text: 'works' }], expectedSeq: 0 })
    await test.tasks.recordRisk(root.id, {
      risk: { id: TaskRiskId('risk'), severity: 'low', summary: 'known', resolution: 'fixed' }, expectedSeq: 1,
    })
    await test.tasks.review(root.id, { decision: 'changes-requested', expectedSeq: 2 })
    expect(root.events.map(current => current.type)).toEqual(['task/defined', 'task/risk-recorded', 'task/review-decided'])
    await expect(test.tasks.recordRisk(root.id, {
      risk: { id: TaskRiskId('bad'), severity: 'low', summary: ' bad ' }, expectedSeq: 3,
    })).rejects.toMatchObject({ code: 'TASK_INVALID_RISK' })
  })

  it('records delivery receipts through dedicated compare-and-set mutations', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    root.append('task/worktree-assigned', { assignment: assignment() })
    root.append('task/defined', { definition: { goal: 'ship', criteria: [
      { id: TaskCriterionId('done'), text: 'works', status: 'pending', evidence: [] },
    ] } })
    root.append('task/criterion-updated', { criterion: {
      id: TaskCriterionId('done'), text: 'works', status: 'satisfied', evidence: [{ sessionId: root.id, seq: 1 }],
    } })
    root.append('task/review-decided', { decision: 'ready' })

    const committed = await test.tasks.recordCommit(root.id, { receipt: commitReceipt(), expectedSeq: 4 })
    const applied = await test.tasks.recordApply(root.id, { receipt: applyReceipt(), expectedSeq: 5 })
    const discarded = await test.tasks.recordDiscard(root.id, { receipt: discardReceipt(), expectedSeq: 6 })

    expect(root.events.map(current => current.type)).toEqual([
      'task/worktree-assigned', 'task/defined', 'task/criterion-updated', 'task/review-decided',
      'task/review-committed', 'task/review-applied', 'task/review-discarded',
    ])
    expect(committed.commitReceipt).toEqual(commitReceipt())
    expect(applied.applyReceipt).toEqual(applyReceipt())
    expect(discarded).toMatchObject({ status: 'settled', discardReceipt: discardReceipt(), asOfSeq: 7 })
    await expect(test.tasks.recordCommit(root.id, { receipt: commitReceipt(), expectedSeq: 6 }))
      .rejects.toMatchObject({ code: 'TASK_STALE_SEQUENCE' })
  })

  it('rejects subagent command targets and every delivery mutation while work is active', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    const child = test.ctx.sessions.create(sid('child'), { meta: { origin: 'subagent', parentSession: root.id } })
    await expect(test.tasks.define(child.id, { goal: 'wrong', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_TARGET_NOT_ROOT' })
    await test.tasks.define(root.id, { goal: 'ship', criteria: [{ text: 'x' }], expectedSeq: 0 })
    test.tasks.replaceLiveGeneration(1, [question(1, 'q').facts[0]!, {
      kind: 'activity', taskId: root.id, ownerSessionId: child.id, sourceId: 'run', state: 'running', createdAt: 2,
    }])
    for (const operation of [
      () => test.tasks.recordCommit(root.id, { receipt: commitReceipt(), expectedSeq: 1 }),
      () => test.tasks.recordApply(root.id, { receipt: applyReceipt(), expectedSeq: 1 }),
      () => test.tasks.recordDiscard(root.id, { receipt: discardReceipt(), expectedSeq: 1 }),
    ]) await expect(operation()).rejects.toMatchObject({ code: 'TASK_ACTIVE' })
    expect(root.events).toHaveLength(1)
  })

  it('classifies malformed definitions as stable Task errors', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    const failure = test.tasks.define(root.id, { goal: ' ship ', criteria: [{ text: 'x' }], expectedSeq: 0 })
    await expect(failure).rejects.toBeInstanceOf(TaskError)
    await expect(failure).rejects.toMatchObject({ code: 'TASK_INVALID_DEFINITION' })
    expect(root.events).toEqual([])
  })

  it('reports missing and unavailable roots with stable errors', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const unavailable = { version: 0, id: sid('unavailable'), createdAt: 1 } satisfies SessionHeader
    ctx.provide('sessionPersistence', {
      listSnapshots: async () => [{ header: unavailable, revision: 'r' }],
      inspect: async () => { throw new Error('corrupt') },
    } as never)
    await ctx.plugin(TaskSessionProvider)
    await expect(ctx.tasks.define(sid('missing'), { goal: 'x', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_NOT_FOUND' })
    await expect(ctx.tasks.define(sid('unavailable'), { goal: 'x', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })
    expect(ctx.tasks.snapshot().tasks[0]?.freshness).toBe('unavailable')
  })

  it('projects optional workspace ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const persisted = persistence()
    ctx.provide('sessionPersistence', persisted.service as never)
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', sessionIds: [sid('root')] }] } as never)
    await ctx.plugin(TaskSessionProvider)
    ctx.sessions.create(sid('root'))
    expect(ctx.tasks.snapshot().tasks[0]?.workspaceId).toBe('workspace')
  })

  it('retains a persisted disposed Session and removes an unpersisted one', async () => {
    const test = await harness()
    const retained = test.ctx.sessions.create(sid('retained'))
    test.persisted.logs.set(retained.id, { meta: retained.header, events: [] })
    test.ctx.emit('session/disposed', retained)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.tasks.snapshot().tasks.map(task => task.taskId)).toContain(retained.id)
    const removed = test.ctx.sessions.create(sid('removed'))
    test.ctx.emit('session/disposed', removed)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.tasks.snapshot().tasks.map(task => task.taskId)).not.toContain(removed.id)
  })

  it('maps cold append races to stale-sequence failures', async () => {
    const cold = Session.create(sid('root'))
    const test = await harness([{ header: cold.header, events: cold.events }])
    test.persisted.append.mockRejectedValueOnce(new Error('raced'))
    await expect(test.tasks.define(cold.id, { goal: 'ship', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_STALE_SEQUENCE' })
    test.persisted.append.mockRejectedValueOnce('string failure')
    await expect(test.tasks.define(cold.id, { goal: 'ship', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_STALE_SEQUENCE', message: 'string failure' })
  })

  it('closes notification registration before Provider disposal completes', async () => {
    const test = await harness()
    test.ctx.sessions.create(sid('root'))
    const heard = vi.fn()
    const tasks = test.tasks
    tasks.onChanged(heard)
    await test.fiber.dispose()
    tasks.replaceLiveGeneration(1, [])
    expect(heard).not.toHaveBeenCalled()
  })
})
