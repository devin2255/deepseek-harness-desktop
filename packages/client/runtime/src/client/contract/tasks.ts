/** Public Client Task service contract. */

import type {
  DefineTaskCriterion, RpcResult, SessionId, TaskCriterion, TaskReviewDecision,
  TaskRisk, TaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from './store.ts'
import type { TaskListState } from '../tasks/manager.ts'

/** Task projection and compare-and-set commands exposed to Client plugins. */
export interface ITasks {
  /** Current Task-list projection. */
  readonly list: ObservableSnapshot<TaskListState>
  /** Refresh the Task baseline. @returns completion of the active request. */
  refresh(): Promise<void>
  /**
   * Define a root Task.
   * @param sessionId - root Session.
   * @param goal - outcome.
   * @param criteria - acceptance criteria.
   * @param expectedSeq - CAS sequence.
   * @returns command result.
   */
  define(
    sessionId: SessionId, goal: string, criteria: readonly DefineTaskCriterion[], expectedSeq: number,
  ): Promise<RpcResult<TaskSnapshot>>
  /** Replace a criterion. @param sessionId - root Session. @param criterion - replacement.
   * @param expectedSeq - CAS sequence. @returns command result. */
  updateCriterion(sessionId: SessionId, criterion: TaskCriterion, expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
  /** Record a risk. @param sessionId - root Session. @param risk - replacement.
   * @param expectedSeq - CAS sequence. @returns command result. */
  recordRisk(sessionId: SessionId, risk: TaskRisk, expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
  /** Record a review decision. @param sessionId - root Session. @param decision - decision.
   * @param expectedSeq - CAS sequence. @returns command result. */
  review(sessionId: SessionId, decision: TaskReviewDecision, expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
}
