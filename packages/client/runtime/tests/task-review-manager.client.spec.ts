import { describe, expect, it } from 'vitest'
import type { SessionId, TaskDeliveryInspection, TaskReviewSummary, TaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { TaskReviewManager } from '../src/client/tasks/review-manager.ts'
import { deferred, err, FakeApiClient, ok } from './fake-api.client.ts'

const taskId = 'root' as SessionId
const revision = 'a'.repeat(64) as TaskReviewSummary['revision']
const operationId = '00000000-0000-4000-8000-000000000001' as NonNullable<TaskSnapshot['retryableDeliveryCheckpoint']>
const inspection: TaskDeliveryInspection = {
  taskId, workspaceId: 'workspace' as never, revision: 'b'.repeat(64) as never, observedAt: 1,
  intent: { kind: 'discard', operationId, reviewRevision: revision, headCommit: '1'.repeat(40),
    confirmedUncommittedLoss: true, uncommittedChanges: true },
  status: 'completed', effect: { kind: 'discard', branch: 'dsh/task-root', headCommit: '1'.repeat(40),
    worktreeRemoved: true, branchPreserved: true, uncommittedChangesDiscarded: true },
}

function summary(files: TaskReviewSummary['files'] = [
  { path: 'src/one.ts', status: 'modified', binary: false, additions: 2, deletions: 1 },
  { path: 'src/two.ts', status: 'added', binary: false, additions: 3, deletions: 0 },
]): TaskReviewSummary {
  return {
    taskId, workspaceId: 'workspace' as never, revision,
    baseCommit: '0'.repeat(40), headCommit: '1'.repeat(40), sourceHead: '0'.repeat(40), sourceDirty: false,
    branch: 'dsh/task-root', dirty: true, truncated: false, files, additions: 5, deletions: 1,
  }
}

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId, workspaceId: 'workspace' as never, descendantSessionIds: [], status: 'ready', freshness: 'live',
    attention: [], risks: [], reviewDecision: 'ready', updatedAt: 1, asOfSeq: 4, ...over,
  }
}

describe('TaskReviewManager reads', () => {
  it('keeps writer reads parent-addressed and refuses root delivery of a child result', async () => {
    const api = new FakeApiClient()
    const writerSessionId = 'writer' as SessionId
    api.onTaskReviewSummary = () => Promise.resolve(ok({ ...summary(), taskId: writerSessionId }))
    api.onTaskReviewDiff = () => Promise.resolve(ok({
      taskId: writerSessionId, workspaceId: 'workspace' as never, revision,
      path: 'src/one.ts', binary: false, truncated: false, patch: '+writer',
    }))
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId, writerSessionId)
    expect(manager.getSnapshot()).toMatchObject({ taskId, writerSessionId, summary: { taskId: writerSessionId } })
    expect(api.callsOf('task.reviewSummary')).toEqual([{ sessionId: taskId, writerSessionId }])
    expect(api.callsOf('task.reviewDiff')).toEqual([{ sessionId: taskId, writerSessionId, path: 'src/one.ts', expectedRevision: revision }])
    await expect(manager.commit('Wrong target', 4)).resolves.toMatchObject({ ok: false })
    await expect(manager.apply('2'.repeat(40), 4)).resolves.toMatchObject({ ok: false })
    await expect(manager.discard(true, 4)).resolves.toMatchObject({ ok: false })
    expect(api.callsOf('task.commit')).toEqual([])
    expect(api.callsOf('task.apply')).toEqual([])
    expect(api.callsOf('task.discard')).toEqual([])
  })

  it('fences a late writer response when switching back to the root result', async () => {
    const api = new FakeApiClient()
    const old = deferred<Awaited<ReturnType<FakeApiClient['onTaskReviewSummary']>>>()
    api.onTaskReviewSummary = () => old.promise
    const manager = new TaskReviewManager(api, async () => {})
    const first = manager.open(taskId, 'writer' as SessionId)
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    await manager.open(taskId)
    old.resolve(ok({ ...summary(), taskId: 'writer' as SessionId }))
    await first
    expect(manager.getSnapshot().writerSessionId).toBeUndefined()
    expect(manager.getSnapshot().summary?.taskId).toBe(taskId)
  })

  it('loads a summary and selected diff, then preserves a still-present selection', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary()))
    api.onTaskReviewDiff = payload => Promise.resolve(ok({
      taskId, workspaceId: 'workspace' as never, revision,
      path: (payload as { path: string }).path, binary: false, truncated: false, patch: '+line\n',
    }))
    const manager = new TaskReviewManager(api, async () => {})

    await manager.open(taskId)
    expect(manager.getSnapshot()).toMatchObject({
      taskId, state: 'ready', freshness: 'fresh', selectedPath: 'src/one.ts',
      diff: { path: 'src/one.ts', patch: '+line\n' },
    })
    await manager.selectFile('src/two.ts')
    expect(manager.getSnapshot().selectedPath).toBe('src/two.ts')
    await manager.refresh()
    expect(manager.getSnapshot().selectedPath).toBe('src/two.ts')
  })

  it('fences obsolete reads and retains stale content across disconnect', async () => {
    const api = new FakeApiClient()
    const old = deferred<Awaited<ReturnType<FakeApiClient['onTaskReviewSummary']>>>()
    api.onTaskReviewSummary = () => old.promise
    const manager = new TaskReviewManager(api, async () => {})
    const first = manager.open(taskId)
    manager.handleDisconnected()
    old.resolve(ok(summary()))
    await first
    expect(manager.getSnapshot()).toMatchObject({ state: 'loading', freshness: 'stale', summary: null })
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    manager.handleConnected()
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', freshness: 'fresh', selectedPath: undefined })
  })

  it('keeps structured summary and diff failures visible and retryable', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(err({
      code: 'task-review-rejected', message: 'Review moved',
      details: { sessionId: taskId, reviewCode: 'REVIEW_STALE' },
    }))
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    expect(manager.getSnapshot()).toMatchObject({ state: 'error', error: { message: 'Review moved' } })

    api.onTaskReviewSummary = () => Promise.resolve(ok(summary()))
    api.onTaskReviewDiff = () => Promise.reject(new Error('connection lost'))
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ state: 'ready', diffState: 'error', error: { message: 'connection lost' } })
  })
})

describe('TaskReviewManager actions', () => {
  it('reads Git evidence despite a missing review without refreshing tasks or inventing a receipt', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(err({
      code: 'task-review-unavailable', message: 'Review directory missing', details: { sessionId: taskId },
    }))
    api.onTaskDeliveryInspection = () => Promise.resolve(ok(inspection))
    let refreshes = 0
    const manager = new TaskReviewManager(api, async () => { refreshes += 1 })
    await expect(manager.inspectDelivery(operationId)).resolves.toMatchObject({ ok: false })
    await manager.open(taskId)
    await expect(manager.inspectDelivery(operationId)).resolves.toMatchObject({ ok: true, value: inspection })
    expect(manager.getSnapshot()).toMatchObject({ deliveryInspection: inspection, deliveryInspectionError: null,
      result: null, operation: null, state: 'error', error: { message: 'Review directory missing' } })
    expect(api.callsOf('task.inspectDelivery')).toEqual([{ sessionId: taskId, operationId }])
    expect(api.callsOf('task.commit')).toEqual([])
    expect(api.callsOf('task.apply')).toEqual([])
    expect(api.callsOf('task.discard')).toEqual([])
    expect(refreshes).toBe(0)
    await manager.open(taskId, 'writer' as SessionId)
    await expect(manager.inspectDelivery(operationId)).resolves.toMatchObject({ ok: false })
    expect(api.callsOf('task.inspectDelivery')).toHaveLength(1)
    expect(manager.getSnapshot().deliveryInspection).toBeNull()
  })

  it('serializes inspection with delivery and clears prior evidence when starting a mutation', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    const pending = deferred<Awaited<ReturnType<FakeApiClient['onTaskDeliveryInspection']>>>()
    api.onTaskDeliveryInspection = () => pending.promise
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    const read = manager.inspectDelivery(operationId)
    expect(manager.getSnapshot().operation).toBe('inspect-delivery')
    await expect(manager.inspectDelivery(operationId)).resolves.toMatchObject({ ok: false })
    await expect(manager.commit('No concurrent write', 4)).resolves.toMatchObject({ ok: false })
    await expect(manager.open(taskId, 'writer' as SessionId)).rejects.toThrow('current delivery operation')
    pending.resolve(ok(inspection))
    await read
    expect(manager.getSnapshot().deliveryInspection).toEqual(inspection)
    await manager.discard(true, 4)
    expect(manager.getSnapshot()).toMatchObject({ deliveryInspection: null, freshness: 'stale' })
  })

  it.each(['refresh', 'task-change'] as const)('suppresses a late inspection after %s', async (change) => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    const pending = deferred<Awaited<ReturnType<FakeApiClient['onTaskDeliveryInspection']>>>()
    api.onTaskDeliveryInspection = () => pending.promise
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    const read = manager.inspectDelivery(operationId)
    if (change === 'refresh') await manager.refresh()
    else manager.invalidateDeliveryInspection()
    pending.resolve(ok(inspection))
    await read
    expect(manager.getSnapshot()).toMatchObject({ deliveryInspection: null, deliveryInspectionError: null, operation: null })
  })

  it('fences disconnected inspection responses after another review and operation begin', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    const old = deferred<Awaited<ReturnType<FakeApiClient['onTaskDeliveryInspection']>>>()
    api.onTaskDeliveryInspection = () => old.promise
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    const first = manager.inspectDelivery(operationId)
    manager.handleDisconnected()
    await manager.open('another' as SessionId)
    const current = deferred<Awaited<ReturnType<FakeApiClient['onTaskDeliveryInspection']>>>()
    api.onTaskDeliveryInspection = () => current.promise
    const second = manager.inspectDelivery(operationId)
    old.resolve(err({ code: 'internal', message: 'Old connection failed', details: {} }))
    await first
    expect(manager.getSnapshot()).toMatchObject({ taskId: 'another', operation: 'inspect-delivery', deliveryInspectionError: null })
    current.resolve(ok({ ...inspection, taskId: 'another' as SessionId }))
    await second
    expect(manager.getSnapshot().deliveryInspection?.taskId).toBe('another')
  })

  it('keeps structured and transport inspection errors separate and clears them on retry or refresh', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    await expect(manager.inspectDelivery(operationId)).resolves.toMatchObject({ ok: false })
    expect(manager.getSnapshot().deliveryInspectionError?.code).toBe('task-delivery-pending')
    api.onTaskDeliveryInspection = () => Promise.reject(new Error('Inspection offline'))
    await manager.inspectDelivery(operationId)
    expect(manager.getSnapshot()).toMatchObject({ error: null, deliveryInspectionError: { message: 'Inspection offline' }, operation: null })
    await manager.refresh()
    expect(manager.getSnapshot().deliveryInspectionError).toBeNull()
  })
  it('saves a receipt even when discard made the review unreadable, without invoking Git delivery', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(err({
      code: 'task-review-rejected', message: 'Worktree was removed', details: { sessionId: taskId, reviewCode: 'REVIEW_WORKTREE_UNAVAILABLE' },
    }))
    api.onTaskMutation = () => Promise.resolve(ok(task({ status: 'settled' })))
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    const operationId = '00000000-0000-4000-8000-000000000001' as NonNullable<TaskSnapshot['retryableDeliveryCheckpoint']>
    await expect(manager.retryDeliveryCheckpoint(operationId)).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('task.retryDeliveryCheckpoint')).toEqual([{ sessionId: taskId, operationId }])
    expect(api.callsOf('task.commit')).toEqual([])
    expect(api.callsOf('task.apply')).toEqual([])
    expect(api.callsOf('task.discard')).toEqual([])
    await manager.open(taskId, 'writer' as SessionId)
    await expect(manager.retryDeliveryCheckpoint(operationId)).resolves.toMatchObject({ ok: false })
    expect(api.callsOf('task.retryDeliveryCheckpoint')).toHaveLength(1)
  })
  it('blocks source switches during delivery and fences a late receipt after disconnect and reselection', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    const delayed = deferred<Awaited<ReturnType<FakeApiClient['onTaskMutation']>>>()
    api.onTaskMutation = () => delayed.promise
    const manager = new TaskReviewManager(api, async () => {})
    await manager.open(taskId)
    const delivery = manager.commit('Review', 4)
    await expect(manager.open(taskId, 'writer' as SessionId)).rejects.toThrow('current delivery operation')
    expect(manager.getSnapshot()).toMatchObject({ taskId, operation: 'commit' })
    manager.handleDisconnected()
    api.onTaskReviewSummary = () => Promise.resolve(ok({ ...summary([]), taskId: 'writer' as SessionId }))
    await manager.open(taskId, 'writer' as SessionId)
    delayed.resolve(ok(task()))
    await expect(delivery).resolves.toMatchObject({ ok: true })
    expect(manager.getSnapshot()).toMatchObject({ writerSessionId: 'writer', result: null, operation: null })
    expect(api.callsOf('task.reviewSummary')).toHaveLength(2)
  })

  it('preserves an accepted receipt when refreshing the task projection fails', async () => {
    const api = new FakeApiClient()
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary([])))
    api.onTaskMutation = () => Promise.resolve(ok(task()))
    const manager = new TaskReviewManager(api, async () => { throw new Error('Projection unavailable') })
    await manager.open(taskId)
    await expect(manager.commit('Review', 4)).resolves.toMatchObject({ ok: true })
    expect(manager.getSnapshot()).toMatchObject({ operation: null, result: { taskId }, error: { message: 'Projection unavailable' } })
  })

  it('routes review, commit, apply, and discard with current revision facts and refreshes Task state', async () => {
    const api = new FakeApiClient()
    let taskRefreshes = 0
    api.onTaskReviewSummary = () => Promise.resolve(ok(summary()))
    api.onTaskReviewDiff = payload => Promise.resolve(ok({
      taskId, workspaceId: 'workspace' as never, revision,
      path: (payload as { path: string }).path, binary: false, truncated: false, patch: '',
    }))
    api.onTaskMutation = () => Promise.resolve(ok(task()))
    const manager = new TaskReviewManager(api, async () => { taskRefreshes += 1 })
    await manager.open(taskId)
    await expect(manager.requestChanges(4)).resolves.toMatchObject({ ok: true })
    await expect(manager.commit('feat: done', 5)).resolves.toMatchObject({ ok: true })
    await expect(manager.apply('2'.repeat(40), 6)).resolves.toMatchObject({ ok: true })
    await manager.refresh()
    await expect(manager.discard(false, 7)).resolves.toMatchObject({ ok: true })

    expect(api.callsOf('task.review')).toEqual([{ sessionId: taskId, decision: 'changes-requested', expectedSeq: 4 }])
    expect(api.callsOf('task.commit')).toEqual([{ sessionId: taskId, expectedRevision: revision, message: 'feat: done', expectedSeq: 5 }])
    expect(api.callsOf('task.apply')).toEqual([{
      sessionId: taskId, expectedRevision: revision, expectedSourceHead: '0'.repeat(40), commit: '2'.repeat(40), expectedSeq: 6,
    }])
    expect(api.callsOf('task.discard')).toEqual([{
      sessionId: taskId, expectedRevision: revision, confirmedUncommittedLoss: false, expectedSeq: 7,
    }])
    expect(taskRefreshes).toBe(4)
    expect(manager.getSnapshot()).toMatchObject({ operation: null, result: { taskId } })
  })
})
