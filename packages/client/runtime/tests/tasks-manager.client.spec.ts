import { describe, expect, it } from 'vitest'
import type { SessionId, TaskSnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import { TaskManager } from '../src/client/tasks/manager.ts'
import { FakeApiClient, deferred, err, ok } from './fake-api.client.ts'

const sid = (value: string): SessionId => value as SessionId

function task(id: string, over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: sid(id), descendantSessionIds: [], status: 'running', freshness: 'live',
    attention: [], risks: [], updatedAt: 1, asOfSeq: 0, ...over,
  }
}

describe('TaskManager baseline lifecycle', () => {
  it('moves from pending loading to a ready fresh baseline', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onTaskList']>>>()
    api.onTaskList = () => gate.promise
    const manager = new TaskManager(api)
    expect(manager.getSnapshot()).toMatchObject({ phase: 'pending', state: 'idle', freshness: 'stale', generation: null })
    const refresh = manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ phase: 'pending', state: 'loading' })
    gate.resolve(ok({ generation: 1, tasks: [task('one')] }))
    await refresh
    expect(manager.getSnapshot()).toMatchObject({ phase: 'ready', state: 'idle', freshness: 'fresh', generation: 1, ids: ['one'] })
  })

  it('retains rows across business and transport refresh failures', async () => {
    const api = new FakeApiClient()
    const manager = new TaskManager(api)
    api.onTaskList = () => Promise.resolve(ok({ generation: 1, tasks: [task('kept')] }))
    await manager.refresh()
    api.onTaskList = () => Promise.resolve(err({ code: 'internal', message: 'down', details: {} }))
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ phase: 'ready', state: 'error', ids: ['kept'], error: { message: 'down' } })
    api.onTaskList = () => Promise.reject(new Error('wire down'))
    await manager.refresh()
    expect(manager.getSnapshot()).toMatchObject({ state: 'error', ids: ['kept'], error: { message: 'wire down' } })
  })

  it.each(['success', 'failure', 'rejection'] as const)('cannot publish an old %s after reconnect', async (outcome) => {
    const api = new FakeApiClient()
    const manager = new TaskManager(api)
    api.onTaskList = () => Promise.resolve(ok({ generation: 1, tasks: [task('retained')] }))
    await manager.refresh()
    const old = deferred<Awaited<ReturnType<FakeApiClient['onTaskList']>>>()
    api.onTaskList = () => old.promise
    const obsolete = manager.refresh()
    manager.handleDisconnected()
    expect(manager.getSnapshot()).toMatchObject({ state: 'loading', freshness: 'stale', generation: null, ids: ['retained'] })
    api.onTaskList = () => Promise.resolve(ok({ generation: 2, tasks: [task('fresh')] }))
    manager.handleConnected()
    await manager.refresh()
    if (outcome === 'success') old.resolve(ok({ generation: 1, tasks: [task('obsolete')] }))
    else if (outcome === 'failure') old.resolve(err({ code: 'internal', message: 'obsolete', details: {} }) as never)
    else old.reject(new Error('obsolete'))
    await obsolete
    expect(manager.getSnapshot()).toMatchObject({ state: 'idle', freshness: 'fresh', generation: 2, ids: ['fresh'] })
  })

  it('replays matching in-flight changes, ignores other generations, and applies whole-row removal and upsert', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onTaskList']>>>()
    api.onTaskList = () => gate.promise
    const manager = new TaskManager(api)
    const refresh = manager.refresh()
    manager.handleHostEnvelope({ rpcId: 'f1' as never, payload: { type: 'task/changed', generation: 2, upserts: [task('new')], removed: [sid('old')] } })
    manager.handleHostEnvelope({ rpcId: 'f2' as never, payload: { type: 'task/changed', generation: 1, upserts: [task('wrong')], removed: [] } })
    gate.resolve(ok({ generation: 2, tasks: [task('old')] }))
    await refresh
    expect(manager.getSnapshot().ids).toEqual(['new'])
    manager.handleHostEnvelope({ rpcId: 'f3' as never, payload: { type: 'task/changed', generation: 3, upserts: [task('ignored')], removed: [] } })
    manager.handleHostEnvelope({ rpcId: 'f4' as never, payload: { type: 'task/changed', generation: 2, upserts: [task('new', { status: 'ready' }), task('last')], removed: [] } })
    expect(manager.getSnapshot().ids).toEqual(['new', 'last'])
    expect(manager.getSnapshot().byId[sid('new')]?.status).toBe('ready')
  })
})

describe('TaskManager commands', () => {
  it('refreshes after success and preserves structured business and transport failures', async () => {
    const api = new FakeApiClient()
    const manager = new TaskManager(api)
    api.onTaskMutation = () => Promise.resolve(ok(task('root')))
    await expect(manager.define(sid('root'), 'Ship', [], 0)).resolves.toMatchObject({ ok: true })
    await expect(manager.updateCriterion(sid('root'), {
      id: 'criterion' as never, text: 'Passes', status: 'satisfied', evidence: [],
    }, 1)).resolves.toMatchObject({ ok: true })
    expect(api.callsOf('task.list')).toHaveLength(2)
    api.onTaskMutation = () => Promise.resolve(err({ code: 'task-active', message: 'active', details: { sessionId: sid('root') } }))
    await expect(manager.review(sid('root'), 'ready', 1)).resolves.toMatchObject({ ok: false, error: { code: 'task-active' } })
    api.onTaskMutation = () => Promise.reject(new Error('lost'))
    await expect(manager.recordRisk(sid('root'), { id: 'risk' as never, severity: 'low', summary: 'Risk' }, 1))
      .resolves.toMatchObject({ ok: false, error: { code: 'internal', message: 'lost' } })
    expect(api.callsOf('task.list')).toHaveLength(2)
  })
})
