import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry, type TaskReviewState } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, type TaskReviewInjected } from '../src/client/index.ts'
import { apply as nodeApply } from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const review: TaskReviewState = {
    taskId: undefined, state: 'idle', diffState: 'idle', freshness: 'stale', summary: null,
    selectedPath: undefined, diff: null, error: null, operation: null, result: null,
    deliveryInspection: null, deliveryInspectionError: null,
  }
  const reviewState = { getSnapshot: () => review, subscribe: () => () => {} }
  const tasks = {
    reviewState, refreshReview: vi.fn(async () => {}), selectReviewFile: vi.fn(async () => {}), openReview: vi.fn(async () => {}),
    requestChanges: vi.fn(async () => ({})), commitReview: vi.fn(async () => ({})),
    applyReview: vi.fn(async () => ({})), discardReview: vi.fn(async () => ({})),
    retryDeliveryCheckpoint: vi.fn(async () => ({})),
    inspectDelivery: vi.fn(async () => ({})),
  }
  const layout = { showHome: vi.fn() }
  const sessions = { refreshSubagents: vi.fn(async () => {}), setSubagentCatalogOpen: vi.fn() }
  ctx.provide('tasks', tasks as never)
  ctx.provide('layout', layout as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  slots.register(
    { name: 'root', children: { 'shell.review': { kind: 'single', scope: 'root' } }, inject: () => ({}) },
    ({ renderSlot }: PropsRenderSlots<'shell.review'>) => renderSlot('shell.review', {}),
  )
  return { ctx, slots, tasks, sessions, layout, reviewState, review }
}

describe('Task Review composition', () => {
  it('registers the workspace and injects only the narrow runtime actions', async () => {
    const b = await bench()
    expect(inject).toEqual(['slots', 'tasks', 'sessions', 'layout', 'locale'])
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(b.slots.entries('shell.review')).toHaveLength(1)
    expect(b.slots.entries('shell.review')[0]?.locale).toBe('taskReview')
    const face = (b.slots.entries('shell.review')[0]!.inject as unknown as () => TaskReviewInjected)()
    expect(face.hooks.taskReview).toBe(b.reviewState)
    face.showTasks()
    await face.refresh()
    vi.spyOn(b.reviewState, 'getSnapshot').mockReturnValue({ ...b.review, taskId: 'root' as never })
    await face.refresh()
    expect(b.sessions.refreshSubagents).toHaveBeenCalledWith('root')
    face.setSourcesOpen('root' as never, true)
    expect(b.sessions.setSubagentCatalogOpen).toHaveBeenCalledWith('root', true)
    await face.selectFile('src/app.ts')
    await face.selectSource('root' as never, 'writer' as never)
    await face.requestChanges(1)
    await face.commit('feat: done', 2)
    await face.apply('a'.repeat(40), 3)
    await face.discard(true, 4)
    await face.retryDeliveryCheckpoint('00000000-0000-4000-8000-000000000001' as never)
    expect(b.tasks.retryDeliveryCheckpoint).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    await face.inspectDelivery('00000000-0000-4000-8000-000000000001' as never)
    expect(b.tasks.inspectDelivery).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001')
    expect(b.layout.showHome).toHaveBeenCalledOnce()
    expect(b.tasks.selectReviewFile).toHaveBeenCalledWith('src/app.ts')
    expect(b.tasks.openReview).toHaveBeenCalledWith('root', 'writer')
    expect(b.tasks.discardReview).toHaveBeenCalledWith(true, 4)
    await fiber.dispose()
    expect(b.slots.entries('shell.review')).toHaveLength(0)
  })
})

describe('node half and invariant companion', () => {
  it('keeps the node half inert and registers invariant ownership', async () => {
    expect(() => { nodeApply() }).not.toThrow()
    const register = vi.fn().mockReturnValue(() => {})
    const dispose = await invariant.apply({ invariants: { register } } as never)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-task-review', expect.any(Function))
    expect(() => { (register.mock.calls[0]![1] as () => void)() }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})
