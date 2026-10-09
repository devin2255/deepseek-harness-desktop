import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject, type OverviewInjected } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'

async function bench(includeTasks = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const sessions = { refresh: vi.fn(async () => {}), open: vi.fn(), list: { getSnapshot: () => ({ state: 'idle', phase: 'ready', byId: { root: { id: 'root' }, child: { id: 'child', origin: 'subagent', parentId: 'root' } }, subagentsByParent: {} }), subscribe: vi.fn(() => () => {}) }, subagentAddress: vi.fn(), refreshSubagents: vi.fn(async () => {}), openSubagent: vi.fn() }
  const workspaces = {
    refresh: vi.fn(async () => {}), startSession: vi.fn(), connectWorkspace: vi.fn(async () => 'isolated'),
    archiveSession: vi.fn(async () => {}), unarchiveSession: vi.fn(async () => {}),
    list: { getSnapshot: () => ({ state: 'idle' }) },
  }
  const tasks = { refresh: vi.fn(async () => {}), openReview: vi.fn(async () => {}), list: { getSnapshot: () => ({ state: 'idle' }) } }
  const layout = { showHome: vi.fn(), showConversation: vi.fn(), showReview: vi.fn(), showStudio: vi.fn() }
  const hostDescription = { getSnapshot: () => ({}), subscribe: vi.fn(() => () => {}) }
  const locale = new LocaleRuntime(ctx)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', workspaces as never)
  if (includeTasks) ctx.provide('tasks', tasks as never)
  ctx.provide('layout', layout as never)
  ctx.provide('connection', { hostDescription } as never)
  ctx.provide('locale', locale)
  const declare = () => slots.register({ name: 'root', children: {
    'shell.home': { kind: 'single', scope: 'root' },
    'shell.studio': { kind: 'single', scope: 'session-maybe' },
    'sidebar.footer.action': { kind: 'list', scope: 'root' },
  } }, ({ renderSlot }: PropsRenderSlots<'shell.home' | 'sidebar.footer.action'>) => [
    renderSlot('shell.home', {}), renderSlot('sidebar.footer.action', { wide: true }),
  ])
  const face = () => (slots.entries('shell.home')[0]!.inject as () => OverviewInjected)()
  return { ctx, slots, sessions, workspaces, tasks, layout, hostDescription, locale, declare, face }
}

function installDesktopBridge(
  onOpenSession: (listener: (sessionId: never) => void) => () => void,
): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'deepseekDesktop')
  Object.defineProperty(globalThis, 'deepseekDesktop', {
    configurable: true,
    value: { onOpenSession },
  })
  return () => {
    if (original === undefined) Reflect.deleteProperty(globalThis, 'deepseekDesktop')
    else Object.defineProperty(globalThis, 'deepseekDesktop', original)
  }
}

describe('overview composition', () => {
  it('has no host-side effects', () => {
    expect(applyHost).not.toThrow()
  })

  it('opens a catalog task in Studio without changing its recorded session', async () => {
    const b = await bench()
    b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    expect(b.face().hooks.studioAvailable.getSnapshot()).toBe(false)
    const onStudioChange = vi.fn()
    const unsubscribeStudio = b.face().hooks.studioAvailable.subscribe(onStudioChange)
    b.face().openStudio('root' as never)
    expect(b.layout.showStudio).not.toHaveBeenCalled()
    const stopStudio = b.slots.register({ name: 'shell.studio' }, () => null)
    expect(b.face().hooks.studioAvailable.getSnapshot()).toBe(true)
    await vi.waitFor(() => { expect(onStudioChange).toHaveBeenCalled() })
    b.face().openStudio('root' as never)
    expect(b.sessions.open).toHaveBeenCalledExactlyOnceWith('root')
    expect(b.layout.showStudio).toHaveBeenCalledOnce()
    b.face().openStudio('missing' as never)
    expect(b.layout.showStudio).toHaveBeenCalledOnce()
    stopStudio()
    unsubscribeStudio()
    await fiber.dispose()
  })

  it('ignores interactions while loading and rejects archive changes without Task projection', async () => {
    const b = await bench(false)
    b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    const face = b.face()
    await face.openReview('root' as never)
    await expect(face.archiveTask('root' as never)).rejects.toThrow('Task data is unavailable')
    await face.refresh()
    expect(b.sessions.refresh).toHaveBeenCalledOnce()
    expect(b.workspaces.refresh).toHaveBeenCalledOnce()

    vi.spyOn(b.sessions.list, 'getSnapshot').mockReturnValue({ state: 'loading' } as never)
    await face.openReview('root' as never)
    await face.startTask('ws' as never, 'worktree')
    await face.refresh()
    await expect(face.archiveTask('root' as never)).rejects.toThrow('Task data is unavailable')
    await expect(face.restoreTask('root' as never)).rejects.toThrow('Archived task is unavailable')
    expect(b.workspaces.connectWorkspace).not.toHaveBeenCalled()
    expect(b.sessions.refresh).toHaveBeenCalledOnce()
    await fiber.dispose()
  })

  it('does not reveal a page after review or workspace connection finishes beyond disposal', async () => {
    const b = await bench()
    b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    let finishReview!: () => void
    let finishConnect!: (id: string) => void
    b.tasks.openReview.mockImplementation(() => new Promise<void>((resolve) => { finishReview = resolve }))
    b.workspaces.connectWorkspace.mockImplementation(() => new Promise<string>((resolve) => { finishConnect = resolve }))
    const face = b.face()
    const review = face.openReview('root' as never)
    const connecting = face.startTask('ws' as never, 'worktree')
    await fiber.dispose()
    finishReview()
    finishConnect('isolated')
    await Promise.all([review, connecting])
    expect(b.layout.showReview).not.toHaveBeenCalled()
    expect(b.layout.showConversation).not.toHaveBeenCalled()
    expect(b.sessions.open).not.toHaveBeenCalled()
  })

  it('archives only a fresh settled task without active agents or attention and restores archived tasks', async () => {
    const b = await bench()
    b.declare()
    const fiber = b.ctx.plugin({ inject, apply })
    await fiber.await()
    const task: { taskId: string; status: string; freshness: string; attention: { id: string }[]; descendantSessionIds: string[] } = {
      taskId: 'root', status: 'settled', freshness: 'live', attention: [], descendantSessionIds: ['child'],
    }
    let taskList = { phase: 'ready', freshness: 'fresh', state: 'idle', byId: { root: task } }
    let workspaceList = { phase: 'ready', state: 'idle', archivedSessionIds: ['root'] }
    let sessionList = {
      state: 'idle', phase: 'ready', byId: { root: { id: 'root', running: false }, child: { id: 'child', running: false } },
      subagentsByParent: {},
    }
    vi.spyOn(b.tasks.list, 'getSnapshot').mockImplementation(() => taskList)
    vi.spyOn(b.workspaces.list, 'getSnapshot').mockImplementation(() => workspaceList)
    vi.spyOn(b.sessions.list, 'getSnapshot').mockImplementation(() => sessionList as never)

    await b.face().archiveTask('root' as never)
    expect(b.workspaces.archiveSession).toHaveBeenCalledExactlyOnceWith('root')
    await b.face().restoreTask('root' as never)
    expect(b.workspaces.unarchiveSession).toHaveBeenCalledExactlyOnceWith('root')

    for (const denied of [
      { ...task, status: 'running' },
      { ...task, freshness: 'stale' },
      { ...task, attention: [{ id: 'pending' }] },
    ]) {
      taskList = { ...taskList, byId: { root: denied } }
      await expect(b.face().archiveTask('root' as never)).rejects.toThrow('Only settled tasks')
    }
    taskList = { ...taskList, byId: { root: task } }
    sessionList = { ...sessionList, byId: { ...sessionList.byId, child: { id: 'child', running: true } } }
    await expect(b.face().archiveTask('root' as never)).rejects.toThrow('Only settled tasks')
    sessionList = { ...sessionList, byId: { root: { id: 'root', running: true }, child: { id: 'child', running: false } } }
    await expect(b.face().archiveTask('root' as never)).rejects.toThrow('Only settled tasks')
    sessionList = { ...sessionList, byId: { root: { id: 'root', running: false }, child: { id: 'child', running: false } } }
    taskList = { ...taskList, freshness: 'stale' }
    await expect(b.face().archiveTask('root' as never)).rejects.toThrow('Only settled tasks')
    taskList = { ...taskList, freshness: 'fresh' }
    workspaceList = { ...workspaceList, archivedSessionIds: [] }
    await expect(b.face().restoreTask('root' as never)).rejects.toThrow('Archived task is unavailable')
    expect(b.workspaces.archiveSession).toHaveBeenCalledTimes(1)
    expect(b.workspaces.unarchiveSession).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('consumes an early desktop target, presents failure on Home, and disposes the bridge listener', async () => {
    let listener: ((sessionId: never) => void) | undefined
    const release = vi.fn(() => { listener = undefined })
    const restore = installDesktopBridge((next) => {
      listener = next
      next('root' as never)
      return release
    })
    try {
      const b = await bench()
      b.declare()
      const fiber = b.ctx.plugin({ inject, apply })
      await fiber.await()
      await vi.waitFor(() => { expect(b.sessions.open).toHaveBeenCalledWith('root') })

      listener?.('missing' as never)
      await vi.waitFor(() => { expect(b.layout.showHome).toHaveBeenCalledOnce() })
      expect(b.face().hooks.desktopNavigationFailure.getSnapshot()).toContain('no longer available')
      listener?.('root' as never)
      expect(b.face().hooks.desktopNavigationFailure.getSnapshot()).toBeUndefined()
      await fiber.dispose()
      expect(release).toHaveBeenCalledOnce()
      expect(listener).toBeUndefined()
    } finally {
      restore()
    }
  })

  it.each(['home', 'conversation', 'review'] as const)('abandons child lookup after explicit navigation to %s', async (page) => {
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
    await face.startTask('ws' as never, 'worktree')
    await face.startTask('ws' as never, 'direct')
    await face.startTask(undefined, 'worktree')
    expect(b.workspaces.connectWorkspace.mock.calls).toEqual([['ws', 'worktree'], ['ws', 'direct']])
    expect(b.sessions.open.mock.calls.slice(0, 2)).toEqual([['isolated'], ['isolated']])
    expect(b.workspaces.startSession).toHaveBeenCalledWith()
    expect(b.layout.showConversation).toHaveBeenCalledTimes(3)
    await face.refresh()
    expect(b.sessions.refresh).toHaveBeenCalledOnce()
    expect(b.workspaces.refresh).toHaveBeenCalledOnce()
    expect(b.tasks.refresh).toHaveBeenCalledOnce()
    await face.openTask('root' as never)
    expect(b.sessions.open).toHaveBeenCalledWith('root')
    await face.openReview('root' as never)
    expect(b.tasks.openReview).toHaveBeenCalledWith('root')
    expect(b.layout.showReview).toHaveBeenCalledOnce()
    const footer = (b.slots.entries('sidebar.footer.action')[0]!.inject as () => { showHome(): void })()
    footer.showHome()
    expect(b.layout.showHome).toHaveBeenCalledOnce()
    await fiber.dispose()
    await face.openTask('root' as never)
    expect(b.sessions.open).toHaveBeenCalledTimes(3)
  })
})
