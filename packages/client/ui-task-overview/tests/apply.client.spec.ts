import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, type OverviewInjected } from '../src/client/index.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const sessions = { refresh: vi.fn(async () => {}), open: vi.fn(), list: { getSnapshot: () => ({ state: 'idle', byId: { root: { id: 'root' }, child: { id: 'child', origin: 'subagent', parentId: 'root' } }, subagentsByParent: {} }) }, subagentAddress: vi.fn(), refreshSubagents: vi.fn(async () => {}), openSubagent: vi.fn() }
  const workspaces = { refresh: vi.fn(async () => {}), startSession: vi.fn(), list: { getSnapshot: () => ({ state: 'idle' }) } }
  const tasks = { refresh: vi.fn(async () => {}), list: { getSnapshot: () => ({ state: 'idle' }) } }
  const layout = { showHome: vi.fn(), showConversation: vi.fn() }
  const hostDescription = { getSnapshot: () => ({}), subscribe: () => () => {} }
  const locale = new LocaleRuntime(ctx)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  ctx.provide('tasks', tasks as never)
  ctx.provide('layout', layout as never)
  ctx.provide('connection', { hostDescription } as never)
  ctx.provide('locale', locale)
  const declare = () => slots.register({ name: 'root', children: { 'shell.home': { kind: 'single', scope: 'root' }, 'sidebar.footer.action': { kind: 'list', scope: 'root' } } }, ({ renderSlot }: PropsRenderSlots<'shell.home' | 'sidebar.footer.action'>) => [renderSlot('shell.home', {}), renderSlot('sidebar.footer.action', { wide: true })])
  const face = () => (slots.entries('shell.home')[0]!.inject as () => OverviewInjected)()
  return { ctx, slots, sessions, workspaces, tasks, layout, hostDescription, locale, declare, face }
}

describe('overview composition', () => {
  it.each(['home', 'conversation'] as const)('abandons child lookup after explicit navigation to %s', async (page) => {
    const b = await bench()
    b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    let finish!: () => void
    b.sessions.refreshSubagents.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
    const opening = b.face().openTask('child' as never)
    b.ctx.emit('layout/navigate', page)
    b.sessions.subagentAddress.mockReturnValue({ parentSessionId: 'root', childSessionId: 'child', mode: 'fork' })
    finish()
    await opening
    expect(b.sessions.openSubagent).not.toHaveBeenCalled()
    expect(b.layout.showConversation).not.toHaveBeenCalled()
    await fiber.dispose()
  })
  it('waits for declarations and unwinds both contributions and dictionaries', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(b.slots.entries('shell.home')).toHaveLength(0)
    const removeOwner = b.declare()
    await Promise.resolve()
    expect(b.slots.entries('shell.home')).toHaveLength(1)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(1)
    expect(b.face().hooks.hostDescription).toBe(b.hostDescription)
    removeOwner()
    expect(b.slots.entries('shell.home')).toHaveLength(0)
    b.declare()
    await Promise.resolve()
    expect(b.slots.entries('shell.home')).toHaveLength(1)
    await fiber.dispose()
    expect(b.slots.entries('shell.home')).toHaveLength(0)
    expect(b.slots.entries('sidebar.footer.action')).toHaveLength(0)
  })
  it('routes new tasks, refreshes all three mirrors and reveals root navigation', async () => {
    const b = await bench()
    b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    const face = b.face()
    face.startTask('ws' as never)
    face.startTask()
    expect(b.workspaces.startSession.mock.calls).toEqual([['ws'], [undefined]])
    expect(b.layout.showConversation).toHaveBeenCalledTimes(2)
    await face.refresh()
    expect(b.sessions.refresh).toHaveBeenCalledOnce()
    expect(b.workspaces.refresh).toHaveBeenCalledOnce()
    expect(b.tasks.refresh).toHaveBeenCalledOnce()
    await face.openTask('root' as never)
    expect(b.sessions.open).toHaveBeenCalledWith('root')
    const footer = (b.slots.entries('sidebar.footer.action')[0]!.inject as () => { showHome(): void })()
    footer.showHome()
    expect(b.layout.showHome).toHaveBeenCalledOnce()
    await fiber.dispose()
    await face.openTask('root' as never)
    expect(b.sessions.open).toHaveBeenCalledOnce()
  })
})
