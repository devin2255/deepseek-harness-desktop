import { describe, expect, it } from 'vitest'
import type { SessionId, TaskReviewSummary, TaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { TaskReviewManager } from '../src/client/tasks/review-manager.ts'
import { deferred, err, FakeApiClient, ok } from './fake-api.client.ts'

const taskId = 'root' as SessionId
const revision = 'a'.repeat(64) as TaskReviewSummary['revision']

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
