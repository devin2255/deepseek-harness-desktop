/** Durable task values shared by providers, protocol adapters, and clients. @module @deepseek-ai/dsh-task/types */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Opaque identity of one acceptance criterion. */
export type TaskCriterionId = Branded<'TaskCriterionId'>

/**
 * Brand a validated criterion identity.
 * @param value - provider-produced opaque identity.
 * @returns the branded identity.
 */
export function TaskCriterionId(value: string): TaskCriterionId {
  return value as TaskCriterionId
}

/** Opaque identity of one task risk. */
export type TaskRiskId = Branded<'TaskRiskId'>

/**
 * Brand a validated risk identity.
 * @param value - provider-produced opaque identity.
 * @returns the branded identity.
 */
export function TaskRiskId(value: string): TaskRiskId {
  return value as TaskRiskId
}

/** Opaque identity of one item in the unified attention queue. */
export type AttentionItemId = Branded<'AttentionItemId'>

/**
 * Brand a validated attention-item identity.
 * @param value - provider-produced opaque identity.
 * @returns the branded identity.
 */
export function AttentionItemId(value: string): AttentionItemId {
  return value as AttentionItemId
}

/** Durable state of one acceptance criterion. */
export type TaskCriterionStatus = 'pending' | 'satisfied' | 'failed' | 'waived'

/** User-facing severity of a recorded task risk. */
export type TaskRiskSeverity = 'low' | 'medium' | 'high' | 'critical'

/** Explicit review or landing decision for a task. */
export type TaskReviewDecision = 'changes-requested' | 'ready' | 'committed' | 'applied' | 'archived' | 'discarded'

/** Derived operational state of one root task and its owned descendants. */
export type TaskStatus = 'needs-attention' | 'failed' | 'running' | 'reviewing' | 'ready' | 'settled'

/** Availability of the inputs used to derive a task row. */
export type TaskFreshness = 'live' | 'disconnected' | 'unavailable'

/** Merge-extensible attention categories keyed by their wire discriminant. */
export interface AttentionKindMap {
  approval: unknown
  question: unknown
  'plan-review': unknown
  'run-failure': unknown
  'merge-conflict': unknown
  'validation-failure': unknown
  'review-request': unknown
}

/** Source category of an attention item. */
export type AttentionKind = keyof AttentionKindMap

/** User-facing urgency of an attention item. */
export type AttentionSeverity = 'info' | 'warning' | 'error' | 'critical'

/** Reference to one exact durable event inside the same task tree. */
export interface TaskEvidenceRef {
  readonly sessionId: SessionId
  readonly seq: number
}

/** One independently reviewable acceptance criterion. */
export interface TaskCriterion {
  readonly id: TaskCriterionId
  readonly text: string
  readonly status: TaskCriterionStatus
  readonly evidence: readonly TaskEvidenceRef[]
}

/** User-authored outcome and acceptance criteria for one root task. */
export interface TaskDefinition {
  readonly goal: string
  readonly criteria: readonly TaskCriterion[]
}

/** One durable risk and its optional resolution. */
export interface TaskRisk {
  readonly id: TaskRiskId
  readonly severity: TaskRiskSeverity
  readonly summary: string
  readonly resolution?: string
}

/** One actionable or informational item in the unified attention queue. */
export interface AttentionItem {
  readonly id: AttentionItemId
  readonly taskId: SessionId
  readonly ownerSessionId: SessionId
  readonly kind: AttentionKind
  readonly severity: AttentionSeverity
  readonly summary: string
  readonly createdAt: number
  readonly sourceId: string
  readonly actionable: boolean
}

/** Detached whole-row task projection safe to send across process boundaries. */
export interface TaskSnapshot {
  readonly taskId: SessionId
  readonly workspaceId?: WorkspaceId
  readonly definition?: TaskDefinition
  readonly descendantSessionIds: readonly SessionId[]
  readonly status: TaskStatus
  readonly freshness: TaskFreshness
  readonly attention: readonly AttentionItem[]
  readonly risks: readonly TaskRisk[]
  readonly reviewDecision?: TaskReviewDecision
  readonly updatedAt: number
  readonly asOfSeq: number
}

/** Complete ordered task baseline for one runtime generation. */
export interface TaskListSnapshot {
  readonly generation: number
  readonly tasks: readonly TaskSnapshot[]
}

/** Whole-row task changes within one runtime generation. */
export interface TaskListChange {
  readonly generation: number
  readonly upserts: readonly TaskSnapshot[]
  readonly removed: readonly SessionId[]
}

/** Authoritative live activity for one root or descendant Session. */
export interface LiveTaskActivity {
  readonly kind: 'activity'
  readonly taskId: SessionId
  readonly ownerSessionId: SessionId
  readonly sourceId: string
  readonly state: 'running' | 'failed'
  readonly createdAt: number
  readonly summary?: string
}

/** Generation-scoped interactive or informational attention. */
export interface LiveTaskAttention {
  readonly kind: 'attention'
  readonly item: AttentionItem
}

/** Merge-extensible live fact variants keyed by their discriminant. */
export interface LiveTaskFactMap {
  activity: LiveTaskActivity
  attention: LiveTaskAttention
}

/** One generation-scoped fact consumed by a Task Provider. */
export type LiveTaskFact = LiveTaskFactMap[keyof LiveTaskFactMap]

/** One criterion requested while defining a root task. */
export interface DefineTaskCriterion {
  readonly id?: TaskCriterionId
  readonly text: string
}

/** Compare-and-set input for defining or replacing one root task. */
export interface DefineTaskRequest {
  readonly goal: string
  readonly criteria: readonly DefineTaskCriterion[]
  readonly expectedSeq: number
}

/** Compare-and-set input for replacing one criterion. */
export interface UpdateTaskCriterionRequest {
  readonly criterion: TaskCriterion
  readonly expectedSeq: number
}

/** Compare-and-set input for recording or resolving one risk. */
export interface RecordTaskRiskRequest {
  readonly risk: TaskRisk
  readonly expectedSeq: number
}

/** Compare-and-set input for recording one review decision. */
export interface ReviewTaskRequest {
  readonly decision: TaskReviewDecision
  readonly expectedSeq: number
}
