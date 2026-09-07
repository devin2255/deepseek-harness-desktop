/** Pure task-list projection over the runtime's known metadata. */
import type { SessionListState, SessionSummary, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'

/** One ordinary task and its known uninterrupted subagent descendants. */
export interface TaskRow {
  root: SessionSummary
  workspace: WorkspaceView | undefined
  group: 'needs-you' | 'running' | 'other'
  descendants: readonly SessionSummary[]
  pending: readonly (SessionSummary & { pendingInteraction: NonNullable<SessionSummary['pendingInteraction']> })[]
  runningDescendants: number
}

/**
 * Project existing metadata without fetching logs or creating session scopes.
 * @param list - listed roots and all known summaries.
 * @param workspaces - authoritative workspace and archive registry.
 * @returns ordered task rows.
 */
export function selectTasks(list: SessionListState, workspaces: WorkspaceListState): TaskRow[] {
  const archived = new Set(workspaces.archivedSessionIds)
  const roots = [...new Set(list.ids)].flatMap((id) => {
    const root = list.byId[id]
    return root === undefined || root.origin === 'subagent' || root.blank || archived.has(id) ? [] : [root]
  })
  const children = new Map<SessionSummary['id'], SessionSummary[]>()
  for (const child of Object.values(list.byId)) {
    if (child.origin !== 'subagent' || child.parentId === undefined) continue
    const siblings = children.get(child.parentId) ?? []
    siblings.push(child)
    children.set(child.parentId, siblings)
  }
  const rows = roots.map((root): TaskRow => {
    const descendants: SessionSummary[] = []
    const seen = new Set([root.id])
    const queue = [...(children.get(root.id) ?? [])]
    for (const child of queue) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      descendants.push(child)
      queue.push(...(children.get(child.id) ?? []))
    }
    const pending = [root, ...descendants].filter((row): row is TaskRow['pending'][number] => row.pendingInteraction !== undefined)
    const runningDescendants = descendants.filter(row => row.running).length
    return {
      root, descendants, pending, runningDescendants,
      workspace: workspaces.items.find(item => item.sessionIds.includes(root.id)),
      group: pending.length > 0 ? 'needs-you' : root.running || runningDescendants > 0 ? 'running' : 'other',
    }
  })
  const rank = { 'needs-you': 0, running: 1, other: 2 }
  return rows.sort((a, b) => rank[a.group] - rank[b.group] || b.root.updatedAt - a.root.updatedAt || a.root.id.localeCompare(b.root.id))
}
