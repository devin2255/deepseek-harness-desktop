/** Durable task values shared by providers, protocol adapters, and clients. @module @deepseek-ai/dsh-task/types */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Branded } from '@deepseek-ai/dsh-brand'

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

/** Source category of an attention item. */
export type AttentionKind = 'approval' | 'question' | 'plan-review' | 'run-failure' | 'merge-conflict' | 'validation-failure' | 'review-request'

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
