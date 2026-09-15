/** Catalog-authoritative task navigation with one plugin-owned lifetime. */
import type { ISessions, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { ILayout } from '@deepseek-ai/dsh-client-ui-layout/client'

/** A plugin-owned navigation attempt; cancellation leaves the current session untouched. */
interface TaskNavigation {
  open(id: SessionId): Promise<void>
  cancel(): void
  dispose(): void
}

/**
 * Create the latest-click navigation controller for one plugin lifetime.
 * @param sessions - existing session navigation and catalog service.
 * @param layout - conversation presentation action.
 * @returns task opener and disposer fencing unresolved child lookups.
 */
export function createTaskNavigation(sessions: ISessions, layout: Pick<ILayout, 'showConversation'>): TaskNavigation {
  const lifetime = new AbortController()
  let current: { id: SessionId; controller: AbortController; promise: Promise<void> } | undefined
  const cancel = () => { current?.controller.abort(); current = undefined }
  const navigate = async (id: SessionId, signal: AbortSignal): Promise<void> => {
    const summary = sessions.list.getSnapshot().byId[id]
    if (summary === undefined) throw new Error(`Task is no longer available: ${id}`)
    if (summary.origin === 'subagent') {
      let address = sessions.subagentAddress(id)
      if (address === undefined && summary.parentId !== undefined) {
        try { await sessions.refreshSubagents(summary.parentId) }
        catch (error) { if (!signal.aborted) throw error }
        if (signal.aborted) return
        address = sessions.subagentAddress(id)
        if (address === undefined) {
          const catalog = sessions.list.getSnapshot().subagentsByParent[summary.parentId]
          const child = catalog?.entries.find(entry => entry.kind === 'child' && entry.id === id)
          if (child?.kind === 'child') {
            address = { parentSessionId: summary.parentId, childSessionId: child.id, mode: child.mode }
          }
        }
      }
      if (address === undefined) throw new Error(`Subagent address is unavailable: ${id}`)
      sessions.openSubagent(address)
    } else {
      sessions.open(id)
    }
    layout.showConversation()
  }
  return {
    open(id: SessionId): Promise<void> {
      if (lifetime.signal.aborted) return Promise.resolve()
      if (current?.id === id) return current.promise
      cancel()
      const controller = new AbortController()
      const operation = { id, controller, promise: navigate(id, controller.signal) }
      current = operation
      operation.promise = operation.promise.finally(() => { if (current === operation) current = undefined })
      return operation.promise
    },
    cancel,
    dispose(): void { lifetime.abort(); cancel() },
  }
}
