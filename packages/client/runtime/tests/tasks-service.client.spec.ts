import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TaskRuntime } from '../src/client/tasks/service.ts'
import { FakeApiClient, ok } from './fake-api.client.ts'

describe('TaskRuntime', () => {
  it('provides the public service and projects manager changes into its store', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    api.onTaskList = () => Promise.resolve(ok({ generation: 7, tasks: [] }))
    const tasks = new TaskRuntime(ctx, api)
    expect(ctx.get('tasks')).toBe(tasks)
    await tasks.refresh()
    expect(tasks.list.getSnapshot()).toMatchObject({ phase: 'ready', generation: 7, freshness: 'fresh' })
    tasks.handleDisconnected()
    await Promise.resolve()
    expect(tasks.list.getSnapshot()).toMatchObject({ state: 'loading', freshness: 'stale' })
  })
})
