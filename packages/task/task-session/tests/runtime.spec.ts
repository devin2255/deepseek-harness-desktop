import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
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
  const flush = vi.fn(async (session: Session) => {
    persisted.logs.set(session.id, { meta: session.header, events: [...session.events] })
  })
  const stopFlush = ctx.on('session/flush', flush, { global: true })
  const fiber = await ctx.plugin(TaskSessionProvider)
  return { ctx, fiber, persisted, flush, stopFlush, tasks: ctx.tasks as TaskSessionProvider }
}

function readyRoot(root: Session): void {
  root.append('task/worktree-assigned', { assignment: assignment(root.id) })
  root.append('task/defined', { definition: { goal: 'Ship', criteria: [
    { id: TaskCriterionId('done'), text: 'Works', status: 'pending', evidence: [] },
  ] } })
  root.append('task/criterion-updated', { criterion: {
    id: TaskCriterionId('done'), text: 'Works', status: 'waived', evidence: [],
  } })
  root.append('task/review-decided', { decision: 'ready' })
}

const commitIntent = () => ({ kind: 'commit' as const, operationId: commitReceipt().operationId,
  reviewRevision: commitReceipt().reviewRevision, message: 'Ship' })

function preStep(ctx: Context, root: Session) {
  return agentEvents(ctx, { session: root } as Agent).waterfall('agent/pre-step', {
    messages: [], turn: 1, step: 1, signal: new AbortController().signal,
  }, () => Promise.resolve({ kind: 'reject' as const }))
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
    const withoutRegistry = await harness()
    expect(withoutRegistry.ctx.get('workspaceRegistry')).toBeUndefined()
    const unregisteredRoot = withoutRegistry.ctx.sessions.create(sid('unregistered'))
    await expect(withoutRegistry.tasks.assignWorktree(unregisteredRoot.id, {
      assignment: assignment(unregisteredRoot.id), expectedSeq: 0,
    })).rejects.toMatchObject({ code: 'TASK_INVALID_WORKTREE' })

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

  it('flushes delivery authorization and records correlated receipts after intervening Session events', async () => {
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

    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: {
      kind: 'commit', operationId: commitReceipt().operationId, reviewRevision: commitReceipt().reviewRevision, message: 'Ship',
    } })
    expect(test.persisted.logs.get(root.id)?.events.at(-1)?.type).toBe('task/delivery-started')
    root.append('turn/start', { turn: 1 })
    await expect(test.tasks.review(root.id, { decision: 'changes-requested', expectedSeq: root.seq }))
      .rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    const committed = await test.tasks.recordCommit(root.id, { receipt: commitReceipt() })
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: {
      kind: 'apply', operationId: applyReceipt().operationId, reviewRevision: applyReceipt().reviewRevision,
      commit: applyReceipt().commit, sourceHead: applyReceipt().sourceHeadBefore,
    } })
    const applied = await test.tasks.recordApply(root.id, { receipt: applyReceipt() })
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: {
      kind: 'discard', operationId: discardReceipt().operationId, reviewRevision: discardReceipt().reviewRevision,
      confirmedUncommittedLoss: false, headCommit: commitReceipt().commit, uncommittedChanges: false,
    } })
    const discarded = await test.tasks.recordDiscard(root.id, { receipt: discardReceipt() })

    expect(root.events.map(current => current.type)).toEqual([
      'task/worktree-assigned', 'task/defined', 'task/criterion-updated', 'task/review-decided',
      'task/delivery-started', 'turn/start', 'task/review-committed', 'task/delivery-started', 'task/review-applied',
      'task/delivery-started', 'task/review-discarded',
    ])
    expect(committed.commitReceipt).toEqual(commitReceipt())
    expect(applied.applyReceipt).toEqual(applyReceipt())
    expect(discarded).toMatchObject({ status: 'settled', discardReceipt: discardReceipt(), asOfSeq: 11 })
    expect(test.flush).toHaveBeenCalledTimes(6)
    expect(test.persisted.logs.get(root.id)?.events).toEqual(root.events)
    await expect(test.tasks.recordCommit(root.id, { receipt: commitReceipt() }))
      .rejects.toMatchObject({ code: 'TASK_INVALID_COMMIT' })
  })

  it('rejects subagent command targets and delivery authorization while work is active', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    const child = test.ctx.sessions.create(sid('child'), { meta: { origin: 'subagent', parentSession: root.id } })
    await expect(test.tasks.define(child.id, { goal: 'wrong', criteria: [{ text: 'x' }], expectedSeq: 0 }))
      .rejects.toMatchObject({ code: 'TASK_TARGET_NOT_ROOT' })
    await test.tasks.define(root.id, { goal: 'ship', criteria: [{ text: 'x' }], expectedSeq: 0 })
    test.tasks.replaceLiveGeneration(1, [question(1, 'q').facts[0]!, {
      kind: 'activity', taskId: root.id, ownerSessionId: child.id, sourceId: 'run', state: 'running', createdAt: 2,
    }])
    await expect(test.tasks.review(root.id, { decision: 'ready', expectedSeq: 1 }))
      .rejects.toMatchObject({ code: 'TASK_ACTIVE' })
    await expect(test.tasks.startDelivery(root.id, { expectedSeq: 1, intent: {
      kind: 'commit', operationId: commitReceipt().operationId, reviewRevision: commitReceipt().reviewRevision, message: 'Ship',
    } })).rejects.toMatchObject({ code: 'TASK_ACTIVE' })
    expect(root.events).toHaveLength(1)
  })

  it.each(['absent', 'failed'] as const)('retains an unconfirmed intent when the authorization checkpoint is %s', async (failure) => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    readyRoot(root)
    if (failure === 'absent') test.stopFlush()
    else test.flush.mockRejectedValueOnce(new Error('Disk unavailable'))

    await expect(test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() }))
      .rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })
    expect(test.tasks.snapshot().tasks[0]).toMatchObject({
      status: 'needs-attention', attention: [{ kind: 'delivery-unconfirmed', sourceId: commitIntent().operationId }],
    })
    await expect(test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() }))
      .rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    await expect(preStep(test.ctx, root)).rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    expect(root.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(1)
  })

  it('keeps delivery unconfirmed until the live receipt checkpoint finishes', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    readyRoot(root)
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() })
    let release!: () => void
    let entered!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const reached = new Promise<void>((resolve) => { entered = resolve })
    test.flush.mockImplementationOnce(async () => { entered(); await held })
    const completed = test.tasks.recordCommit(root.id, { receipt: commitReceipt() })
    try {
      await reached
      expect(test.tasks.snapshot().tasks[0]?.attention).toContainEqual(expect.objectContaining({ kind: 'delivery-unconfirmed' }))
      await expect(preStep(test.ctx, root)).rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    } finally {
      release()
    }
    const result = await completed
    expect(result.attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(false)
    const delegated = vi.fn(async () => ({ kind: 'reject' as const }))
    test.ctx.on('agent/pre-step', delegated, { global: true })
    await expect(preStep(test.ctx, root)).resolves.toEqual({ kind: 'reject' })
    expect(delegated).toHaveBeenCalledOnce()
  })

  it.each(['absent', 'failed'] as const)('blocks execution and Task changes after a %s receipt checkpoint', async (failure) => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    readyRoot(root)
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() })
    if (failure === 'absent') test.stopFlush()
    else test.flush.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(test.tasks.recordCommit(root.id, { receipt: commitReceipt() }))
      .rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })

    test.tasks.replaceLiveGeneration(2, [])
    expect(test.tasks.snapshot().tasks[0]?.attention).toContainEqual(expect.objectContaining({
      kind: 'delivery-unconfirmed', sourceId: commitIntent().operationId,
    }))
    await expect(test.tasks.review(root.id, { decision: 'changes-requested', expectedSeq: root.seq }))
      .rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    await expect(preStep(test.ctx, root)).rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    const persisted = test.persisted.logs.get(root.id)!
    const cold = await harness([{ header: persisted.meta, events: persisted.events }])
    expect(cold.tasks.snapshot().tasks[0]?.commitReceipt).toBeUndefined()
    expect(cold.tasks.snapshot().tasks[0]?.attention).toContainEqual(expect.objectContaining({ kind: 'delivery-unconfirmed' }))
  })

  it('records cold delivery results after an unrelated Session event without another sequence authorization', async () => {
    const root = Session.create(sid('root'))
    readyRoot(root)
    const test = await harness([{ header: root.header, events: root.events }])
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() })
    const persisted = test.persisted.logs.get(root.id)!
    persisted.events.push({ type: 'turn/start', data: { turn: 1 }, seq: persisted.events.length, time: 20 })
    await test.fiber.dispose()
    await test.ctx.plugin(TaskSessionProvider)
    const result = await test.ctx.tasks.recordCommit(root.id, { receipt: commitReceipt() })
    expect(result.commitReceipt).toEqual(commitReceipt())
    expect(result.attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(false)
    expect(persisted.events.at(-1)?.type).toBe('task/review-committed')
    expect(test.flush).not.toHaveBeenCalled()
  })

  it('retries each existing delivery receipt checkpoint without appending another event', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    readyRoot(root)
    const operations = [
      { intent: commitIntent(), record: () => test.tasks.recordCommit(root.id, { receipt: commitReceipt() }) },
      { intent: { kind: 'apply' as const, operationId: applyReceipt().operationId,
        reviewRevision: applyReceipt().reviewRevision, commit: applyReceipt().commit, sourceHead: applyReceipt().sourceHeadBefore },
      record: () => test.tasks.recordApply(root.id, { receipt: applyReceipt() }) },
      { intent: { kind: 'discard' as const, operationId: discardReceipt().operationId,
        reviewRevision: discardReceipt().reviewRevision, confirmedUncommittedLoss: false,
        headCommit: commitReceipt().commit, uncommittedChanges: false },
      record: () => test.tasks.recordDiscard(root.id, { receipt: discardReceipt() }) },
    ]
    for (const { intent, record } of operations) {
      await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent })
      test.flush.mockRejectedValueOnce(new Error('Disk unavailable'))
      await expect(record()).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })
      expect(test.tasks.snapshot().tasks[0]?.retryableDeliveryCheckpoint).toBe(intent.operationId)
      await expect(test.tasks.retryDeliveryCheckpoint(root.id, TaskReviewOperationId('00000000-0000-4000-8000-000000000099')))
        .rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
      test.flush.mockRejectedValueOnce(new Error('Still unavailable'))
      await expect(test.tasks.retryDeliveryCheckpoint(root.id, intent.operationId)).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })
      expect(test.tasks.snapshot().tasks[0]?.retryableDeliveryCheckpoint).toBe(intent.operationId)
      const events = root.events
      const result = await test.tasks.retryDeliveryCheckpoint(root.id, intent.operationId)
      expect(result.retryableDeliveryCheckpoint).toBeUndefined()
      expect(result.attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(false)
      expect(root.events).toBe(events)
      expect(test.persisted.logs.get(root.id)?.events).toEqual(events)
      await expect(test.tasks.retryDeliveryCheckpoint(root.id, intent.operationId)).rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    }
    expect(test.persisted.logs.get(root.id)?.events.filter(event => event.type === 'task/review-discarded')).toHaveLength(1)
    await expect(preStep(test.ctx, root)).resolves.toEqual({ kind: 'reject' })
  })

  it('does not save a lost receipt or transfer retry authority to a replacement Session', async () => {
    const test = await harness()
    const root = test.ctx.sessions.prepare(sid('root'))
    const detach = test.ctx.sessions.enter(root)
    test.ctx.sessions.announce(root)
    readyRoot(root)
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() })
    const authorization = root.events
    await expect(test.tasks.retryDeliveryCheckpoint(root.id, commitIntent().operationId))
      .rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    test.flush.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(test.tasks.recordCommit(root.id, { receipt: commitReceipt() })).rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })
    detach()
    await new Promise(resolve => setTimeout(resolve, 0))
    const replacement = test.ctx.sessions.create(root.id, { seed: authorization })
    const calls = test.flush.mock.calls.length
    expect(test.tasks.snapshot().tasks[0]?.retryableDeliveryCheckpoint).toBeUndefined()
    await expect(test.tasks.retryDeliveryCheckpoint(root.id, commitIntent().operationId))
      .rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
    expect(test.flush).toHaveBeenCalledTimes(calls)
    await expect(preStep(test.ctx, replacement)).rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
  })

  it('retains uncertainty if a Session detaches while its receipt is being saved', async () => {
    const test = await harness()
    const root = test.ctx.sessions.prepare(sid('root'))
    const detach = test.ctx.sessions.enter(root)
    test.ctx.sessions.announce(root)
    readyRoot(root)
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() })
    test.flush.mockImplementationOnce(async () => { detach() })
    await expect(test.tasks.recordCommit(root.id, { receipt: commitReceipt() }))
      .rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })
    expect(test.tasks.snapshot().tasks[0]?.retryableDeliveryCheckpoint).toBeUndefined()
    expect(test.tasks.snapshot().tasks[0]?.attention).toContainEqual(expect.objectContaining({ kind: 'delivery-unconfirmed' }))
  })

  it('retains checkpoint ownership when a disposed Session becomes unreadable', async () => {
    const test = await harness()
    const root = test.ctx.sessions.create(sid('root'))
    readyRoot(root)
    await test.tasks.startDelivery(root.id, { expectedSeq: root.seq, intent: commitIntent() })
    test.flush.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(test.tasks.recordCommit(root.id, { receipt: commitReceipt() }))
      .rejects.toMatchObject({ code: 'TASK_UNAVAILABLE' })

    test.persisted.logs.delete(root.id)
    test.ctx.emit('session/disposed', root)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.tasks.snapshot().tasks).toEqual([])

    test.ctx.emit('session/created', root)
    expect(test.tasks.snapshot().tasks[0]?.attention).toContainEqual(expect.objectContaining({
      kind: 'delivery-unconfirmed', sourceId: commitIntent().operationId,
    }))
    await expect(preStep(test.ctx, root)).rejects.toMatchObject({ code: 'TASK_DELIVERY_PENDING' })
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
