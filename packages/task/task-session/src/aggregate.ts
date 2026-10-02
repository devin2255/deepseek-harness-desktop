/** Pure cross-Session Task aggregation. */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import {
  AttentionItemId,
  foldTask,
  type AttentionItem,
  type AttentionSeverity,
  type LiveTaskFact,
  type TaskFreshness,
  type TaskListSnapshot,
  type TaskSnapshot,
} from '@deepseek-ai/dsh-task'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Detached Session input; absent events mean the known log could not be inspected. */
export interface TaskSessionInput {
  readonly header: SessionHeader
  readonly events?: readonly SessionEvent[]
}

/** Complete inputs for one generation's Task projection. */
export interface TaskAggregationInput {
  readonly generation: number
  readonly sessions: readonly TaskSessionInput[]
  readonly liveFacts?: readonly LiveTaskFact[]
  readonly freshness?: TaskFreshness
  readonly workspaceBySession?: ReadonlyMap<SessionId, WorkspaceId>
}

/** Invalid subagent lineage that cannot be assigned to exactly one root Task. */
export class TaskLineageError extends Error {
  /** @param message - concrete invalid lineage relationship. */
  constructor(message: string) {
    super(message)
    this.name = 'TaskLineageError'
  }
}

const severityRank: Readonly<Record<AttentionSeverity, number>> = {
  critical: 0,
  error: 1,
  warning: 2,
  info: 3,
}

function rootOf(id: SessionId, sessions: ReadonlyMap<SessionId, TaskSessionInput>): SessionId {
  let current = id
  const seen = new Set<SessionId>()
  while (true) {
    if (seen.has(current)) throw new TaskLineageError(`subagent lineage containing "${id}" has a cycle`)
    seen.add(current)
    const session = sessions.get(current)
    if (session === undefined) throw new TaskLineageError(`subagent lineage containing "${id}" has missing Session "${current}"`)
    if (session.header.origin !== 'subagent') return current
    const parent = session.header.parentSession
    if (parent === undefined) throw new TaskLineageError(`subagent Session "${current}" has no parent Session`)
    current = parent
  }
}

function durableAttention(taskId: SessionId, session: TaskSessionInput): AttentionItem[] {
  if (session.events === undefined) return []
  const openApprovals = new Map<string, { seq: number; time: number; toolName: string; reason?: string }>()
  let lastFailure: SessionEvent<'turn/end'> | undefined
  for (const event of session.events) {
    if (event.type === 'approval/asked') {
      openApprovals.set(event.data.id, {
        seq: event.seq,
        time: event.time,
        toolName: event.data.toolName,
        ...event.data.reason === undefined ? {} : { reason: event.data.reason },
      })
    } else if (event.type === 'approval/decided') {
      openApprovals.delete(event.data.id)
    } else if (event.type === 'turn/end') {
      lastFailure = event.data.reason.kind === 'error' || event.data.reason.kind === 'interrupted'
        ? event
        : undefined
    }
  }
  const items = [...openApprovals].map(([sourceId, asked]): AttentionItem => ({
    id: AttentionItemId(`${session.header.id}:approval:${sourceId}`),
    taskId,
    ownerSessionId: session.header.id,
    kind: 'approval',
    severity: 'warning',
    summary: asked.reason ?? `Approve ${asked.toolName}`,
    createdAt: asked.time,
    sourceId,
    actionable: true,
  }))
  if (lastFailure !== undefined) {
    const sourceId = `turn:${lastFailure.data.turn}`
    const reason = lastFailure.data.reason
    items.push({
      id: AttentionItemId(`${session.header.id}:failure:${sourceId}`),
      taskId,
      ownerSessionId: session.header.id,
      kind: 'run-failure',
      severity: 'error',
      summary: reason.kind === 'error'
        ? reason.error.message
        : 'This Task was interrupted before the turn completed. Review the last tool result before continuing.',
      createdAt: lastFailure.time,
      sourceId,
      actionable: false,
    })
  }
  return items
}

function attentionOrder(taskUpdatedAt: ReadonlyMap<SessionId, number>) {
  return (left: AttentionItem, right: AttentionItem): number =>
    Number(right.actionable) - Number(left.actionable)
    || severityRank[left.severity] - severityRank[right.severity]
    || left.createdAt - right.createdAt
    || (taskUpdatedAt.get(left.taskId) ?? 0) - (taskUpdatedAt.get(right.taskId) ?? 0)
    || String(left.taskId).localeCompare(String(right.taskId))
    || String(left.id).localeCompare(String(right.id))
}

/**
 * Sort a detached attention queue by the Provider's complete stable ordering rule.
 * @param items - attention items from any number of root Tasks.
 * @param taskUpdatedAt - update time for each owning root when known.
 * @returns a detached ordered queue.
 */
export function sortAttentionItems(
  items: readonly AttentionItem[],
  taskUpdatedAt: ReadonlyMap<SessionId, number>,
): AttentionItem[] {
  return [...clone(items)].sort(attentionOrder(taskUpdatedAt))
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

/**
 * Aggregate root Tasks, strict subagent descendants, durable facts, and live facts.
 * @param input - detached complete projection inputs for one generation.
 * @returns a detached, deterministically ordered Task baseline.
 */
export function aggregateTasks(input: TaskAggregationInput): TaskListSnapshot {
  const sessions = new Map(input.sessions.map(session => [session.header.id, session]))
  const rootBySession = new Map<SessionId, SessionId>()
  for (const id of sessions.keys()) rootBySession.set(id, rootOf(id, sessions))
  const descendants = new Map<SessionId, TaskSessionInput[]>()
  for (const session of input.sessions) {
    const rootId = rootBySession.get(session.header.id)
    if (rootId === undefined || rootId === session.header.id) continue
    const current = descendants.get(rootId) ?? []
    current.push(session)
    descendants.set(rootId, current)
  }
  const liveByRoot = new Map<SessionId, LiveTaskFact[]>()
  for (const fact of input.liveFacts ?? []) {
    if (!sessions.has(fact.kind === 'activity' ? fact.ownerSessionId : fact.item.ownerSessionId)) continue
    const declared = fact.kind === 'activity' ? fact.taskId : fact.item.taskId
    const owner = fact.kind === 'activity' ? fact.ownerSessionId : fact.item.ownerSessionId
    if (rootBySession.get(owner) !== declared) continue
    const current = liveByRoot.get(declared) ?? []
    current.push(fact)
    liveByRoot.set(declared, current)
  }
  const taskUpdatedAt = new Map<SessionId, number>()
  const tasks: TaskSnapshot[] = []
  for (const root of input.sessions.filter(session => session.header.origin !== 'subagent')) {
    const children = (descendants.get(root.header.id) ?? []).sort((left, right) =>
      left.header.createdAt - right.header.createdAt || String(left.header.id).localeCompare(String(right.header.id)))
    const tree = [root, ...children]
    const fold = root.events === undefined ? undefined : foldTask(root.events)
    const live = liveByRoot.get(root.header.id) ?? []
    const attention = tree.flatMap(session => durableAttention(root.header.id, session))
    for (const fact of live) if (fact.kind === 'attention') attention.push(clone(fact.item))
    const newestEvent = tree.flatMap(session => session.events ?? []).reduce((latest, event) => Math.max(latest, event.time), 0)
    const newestLive = live.reduce((latest, fact) => Math.max(latest,
      fact.kind === 'activity' ? fact.createdAt : fact.item.createdAt), 0)
    const updatedAt = Math.max(root.header.createdAt, newestEvent, newestLive, fold?.updatedAt ?? 0)
    taskUpdatedAt.set(root.header.id, updatedAt)
    const hasUnavailableLog = tree.some(session => session.events === undefined)
    const actionable = attention.some(item => item.actionable)
    const failed = live.some(fact => fact.kind === 'activity' && fact.state === 'failed')
      || attention.some(item => item.kind === 'run-failure')
    const running = live.some(fact => fact.kind === 'activity' && fact.state === 'running')
    const ready = fold?.reviewDecision === 'ready'
      && fold.definition !== undefined
      && fold.definition.criteria.every(criterion => criterion.status === 'satisfied' || criterion.status === 'waived')
      && fold.risks.every(risk => risk.resolution !== undefined)
    const terminal = fold?.commitReceipt !== undefined
      || fold?.applyReceipt !== undefined
      || fold?.discardReceipt !== undefined
    const reviewing = fold !== undefined
      && !terminal
      && (fold.definition !== undefined || fold.reviewDecision !== undefined || fold.risks.length > 0)
    const status = actionable ? 'needs-attention'
      : failed ? 'failed'
        : running ? 'running'
          : terminal ? 'settled'
            : reviewing && !ready ? 'reviewing'
              : ready ? 'ready'
                : 'settled'
    const orderedAttention = sortAttentionItems(attention, taskUpdatedAt)
    const executionWorkspace = fold?.assignment
    const workspaceId = executionWorkspace?.workspaceId ?? input.workspaceBySession?.get(root.header.id)
    tasks.push({
      taskId: root.header.id,
      ...workspaceId === undefined ? {} : { workspaceId },
      ...executionWorkspace === undefined ? {} : { executionWorkspace: clone(executionWorkspace) },
      ...fold?.definition === undefined ? {} : { definition: clone(fold.definition) },
      descendantSessionIds: children.map(child => child.header.id),
      status,
      freshness: hasUnavailableLog ? 'unavailable' : input.freshness ?? 'live',
      attention: orderedAttention,
      risks: clone(fold?.risks ?? []),
      ...fold?.reviewDecision === undefined ? {} : { reviewDecision: fold.reviewDecision },
      ...fold?.commitReceipt === undefined ? {} : { commitReceipt: clone(fold.commitReceipt) },
      ...fold?.applyReceipt === undefined ? {} : { applyReceipt: clone(fold.applyReceipt) },
      ...fold?.discardReceipt === undefined ? {} : { discardReceipt: clone(fold.discardReceipt) },
      updatedAt,
      asOfSeq: root.events?.length ?? 0,
    })
  }
  tasks.sort((left, right) => right.updatedAt - left.updatedAt || String(left.taskId).localeCompare(String(right.taskId)))
  return { generation: input.generation, tasks: clone(tasks) }
}
