/** Pure task-list projections over durable Tasks or legacy Session activity. */
import type {
  AttentionItem, SessionListState, SessionSummary, TaskListState, TaskSnapshot,
  WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'

/** One legacy ordinary Session and its known uninterrupted subagent descendants. */
export interface SessionActivityRow {
  root: SessionSummary
  workspace: WorkspaceView | undefined
  group: 'needs-you' | 'running' | 'other'
  descendants: readonly SessionSummary[]
  pending: readonly (SessionSummary & { pendingInteraction: NonNullable<SessionSummary['pendingInteraction']> })[]
  runningDescendants: number
}

/** One durable Task enriched only with display metadata from existing client mirrors. */
export interface TaskRow {
  task: TaskSnapshot
  root: SessionSummary | undefined
  workspace: WorkspaceView | undefined
  goal: string
  group: 'needs-you' | 'running' | 'other'
  activeDescendants: number
  criterionProgress: { readonly completed: number; readonly total: number }
  unresolvedRiskCount: number
  attention: readonly { readonly item: AttentionItem; readonly owner: SessionSummary | undefined }[]
}

/**
 * Enrich the authoritative Task projection with current Session and Workspace display metadata.
 * @param list - durable Task projection.
 * @param sessions - current Session summaries used for titles and live descendant counts.
 * @param workspaces - current Workspace registry.
 * @returns Host-ordered Task rows.
 */
export function selectTasks(
  list: TaskListState,
  sessions: SessionListState,
  workspaces: WorkspaceListState,
): TaskRow[] {
  return [...new Set(list.ids)].flatMap((id) => {
    const task = list.byId[id]
    if (task === undefined) return []
    const root = sessions.byId[id]
    const criteria = task.definition?.criteria ?? []
    return [{
      task,
      root,
      workspace: task.workspaceId === undefined
        ? undefined
        : workspaces.items.find(item => item.workspaceId === task.workspaceId),
      goal: task.definition?.goal ?? root?.displayTitle ?? task.taskId,
      group: task.status === 'needs-attention' || task.status === 'failed'
        ? 'needs-you'
        : task.status === 'running' ? 'running' : 'other',
      activeDescendants: task.descendantSessionIds
        .filter(descendantId => sessions.byId[descendantId]?.running === true).length,
      criterionProgress: {
        completed: criteria.filter(criterion => criterion.status === 'satisfied' || criterion.status === 'waived').length,
        total: criteria.length,
      },
      unresolvedRiskCount: task.risks.filter(risk => risk.resolution === undefined).length,
      attention: task.attention.map(item => ({ item, owner: sessions.byId[item.ownerSessionId] })),
    }]
  })
}

/**
 * Project existing metadata without fetching logs or creating session scopes.
 * @param list - listed roots and all known summaries.
 * @param workspaces - authoritative workspace and archive registry.
 * @returns ordered task rows.
 */
export function selectSessionActivity(list: SessionListState, workspaces: WorkspaceListState): SessionActivityRow[] {
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
  const rows = roots.map((root): SessionActivityRow => {
    const descendants: SessionSummary[] = []
    const seen = new Set([root.id])
    const queue = [...(children.get(root.id) ?? [])]
    for (const child of queue) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      descendants.push(child)
      queue.push(...(children.get(child.id) ?? []))
    }
    const pending = [root, ...descendants]
      .filter((row): row is SessionActivityRow['pending'][number] => row.pendingInteraction !== undefined)
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
