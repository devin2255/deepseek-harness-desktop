/** Desktop overview composition; all business state comes from the runtime. */
import type { ClientContext, SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, HostDescriptionSource } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { en, zh, type TaskOverviewKey } from './locales.ts'
import { createTaskNavigation } from './navigation.ts'
import { TaskOverview } from './TaskOverview.tsx'
import { TasksAction } from './TasksAction.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop task overview and footer action. */
    taskOverview: TaskOverviewKey
  }
}

/** Private registration callbacks and transport description source. */
export type OverviewInjected = {
  openTask(id: SessionId): Promise<void>
  startTask(workspaceId: WorkspaceId | undefined, isolation: 'direct' | 'worktree'): Promise<void>
  refresh(): Promise<void>
  hooks: { hostDescription: HostDescriptionSource }
}

/** Services consumed by the desktop overview. */
export const inject = ['slots', 'sessions', 'workspaces', 'layout', 'locale', 'connection']

/**
 * Register the optional home occupant and persistent footer action.
 * @param ctx - client plugin context.
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const tasks = ctx.get('tasks')
  const navigation = createTaskNavigation(ctx.sessions, ctx.layout)
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(); navigation.dispose() }, 'ui-task-overview: navigation lifetime')
  ctx.on('layout/navigate', () => { navigation.cancel() })
  ctx.effect(() => ctx.locale.register('taskOverview', { zh, en }), 'ui-task-overview: dictionaries')
  const ready = () => !lifetime.signal.aborted
    && connection.hostDescription.getSnapshot() !== undefined
    && ctx.sessions.list.getSnapshot().state !== 'loading'
    && ctx.workspaces.list.getSnapshot().state !== 'loading'
    && tasks?.list.getSnapshot().state !== 'loading'
  const injected = (): OverviewInjected => ({
    openTask: id => navigation.open(id),
    startTask: async (workspaceId, isolation) => {
      if (!ready()) return
      navigation.cancel()
      if (workspaceId === undefined) {
        ctx.workspaces.startSession()
        ctx.layout.showConversation()
        return
      }
      const sessionId = await ctx.workspaces.connectWorkspace(workspaceId, isolation)
      if (lifetime.signal.aborted) return
      ctx.sessions.open(sessionId)
      ctx.layout.showConversation()
    },
    refresh: async () => {
      if (!ready()) return
      await Promise.all([
        ctx.sessions.refresh(), ctx.workspaces.refresh(), ...(tasks === undefined ? [] : [tasks.refresh()]),
      ])
    },
    hooks: { hostDescription: connection.hostDescription },
  })
  ctx.slots.inject('shell.home', () => ctx.slots.register({
    name: 'shell.home', locale: 'taskOverview', inject: injected,
  }, TaskOverview))
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action', id: 'tasks', locale: 'taskOverview',
    inject: () => ({ showHome: () => { navigation.cancel(); ctx.layout.showHome() } }),
  }, TasksAction))
}
