import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TaskRuntime } from '../src/client/tasks/service.ts'
import type { SessionId, TaskDeliveryInspection, TaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { FakeApiClient, ok } from './fake-api.client.ts'

describe('TaskRuntime', () => {
  it('provides the public service and projects manager changes into its store', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    api.onTaskList = () => Promise.resolve(ok({ generation: 7, tasks: [] }))
    const tasks = new TaskRuntime(ctx, api)
    expect(ctx.get('tasks')).toBe(tasks)
    await expect(tasks.retryDeliveryCheckpoint('00000000-0000-4000-8000-000000000001' as never)).resolves.toMatchObject({ ok: false })
    await expect(tasks.inspectDelivery('00000000-0000-4000-8000-000000000001' as never)).resolves.toMatchObject({ ok: false })
    await tasks.refresh()
    expect(tasks.list.getSnapshot()).toMatchObject({ phase: 'ready', generation: 7, freshness: 'fresh' })
    tasks.handleDisconnected()
    await Promise.resolve()
    expect(tasks.list.getSnapshot()).toMatchObject({ state: 'loading', freshness: 'stale' })
  })

  it('invalidates selected root evidence on authoritative row replacement or removal, not unrelated changes', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const taskId = 'root' as SessionId
    const root: TaskSnapshot = { taskId, descendantSessionIds: [], status: 'needs-attention', freshness: 'unavailable',
      attention: [], risks: [], updatedAt: 1, asOfSeq: 0 }
    const inspection: TaskDeliveryInspection = {
      taskId, workspaceId: 'workspace' as never, revision: 'b'.repeat(64) as never, observedAt: 1,
      intent: { kind: 'apply', operationId: '00000000-0000-4000-8000-000000000001' as never,
        reviewRevision: 'a'.repeat(64) as never, commit: '1'.repeat(40), sourceHead: '0'.repeat(40) }, status: 'not-completed',
    }
    api.onTaskList = () => Promise.resolve(ok({ generation: 7, tasks: [root] }))
    api.onTaskDeliveryInspection = () => Promise.resolve(ok(inspection))
    const tasks = new TaskRuntime(ctx, api)
    await tasks.refresh()
    await tasks.openReview(taskId)
    await tasks.inspectDelivery(inspection.intent.operationId)
    await Promise.resolve()
    expect(tasks.reviewState.getSnapshot().deliveryInspection).toEqual(inspection)
    tasks.handleHostEnvelope({ rpcId: 'other' as never, payload: { type: 'task/changed', generation: 7,
      upserts: [{ ...root, taskId: 'other' as SessionId }], removed: [] } })
    await Promise.resolve()
    expect(tasks.reviewState.getSnapshot().deliveryInspection).toEqual(inspection)
    tasks.handleHostEnvelope({ rpcId: 'root' as never, payload: { type: 'task/changed', generation: 7,
      upserts: [{ ...root, asOfSeq: 1 }], removed: [] } })
    await Promise.resolve()
    await expect.poll(() => tasks.reviewState.getSnapshot().deliveryInspection).toBeNull()
    await tasks.inspectDelivery(inspection.intent.operationId)
    tasks.handleHostEnvelope({ rpcId: 'removed' as never, payload: { type: 'task/changed', generation: 7,
      upserts: [], removed: [taskId] } })
    await Promise.resolve()
    await expect.poll(() => tasks.reviewState.getSnapshot().deliveryInspection).toBeNull()
  })
})
