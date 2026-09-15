/** Public Client Task service contract. */

import type {
  DefineTaskCriterion, RpcResult, SessionId, TaskCriterion, TaskReviewDecision,
  TaskRisk, TaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from './store.ts'
import type { TaskListState } from '../tasks/manager.ts'
import type { TaskReviewState } from '../tasks/review-manager.ts'

/** Task projection and compare-and-set commands exposed to Client plugins. */
export interface ITasks {
  /** Current Task-list projection. */
  readonly list: ObservableSnapshot<TaskListState>
  /** Current separate Review-workspace projection. */
  readonly reviewState: ObservableSnapshot<TaskReviewState>
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
  /** Open and load one isolated Task review. @param sessionId - root Task. @returns completion of the read. */
  openReview(sessionId: SessionId): Promise<void>
  /** Refresh the currently open review. @returns completion of the read. */
  refreshReview(): Promise<void>
  /** Select one changed file. @param path - review-relative path. @returns completion of the diff read. */
  selectReviewFile(path: string): Promise<void>
  /** Request Agent revisions. @param expectedSeq - Task CAS sequence. @returns command result. */
  requestChanges(expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
  /** Commit the exact review. @param message - Git commit message. @param expectedSeq - Task CAS sequence. @returns command result. */
  commitReview(message: string, expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
  /** Apply the committed review. @param commit - recorded commit. @param expectedSeq - Task CAS sequence. @returns command result. */
  applyReview(commit: string, expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
  /**
   * Release its worktree.
   * @param confirmedUncommittedLoss - Explicit dirty-data confirmation.
   * @param expectedSeq - Task CAS sequence.
   * @returns Command result.
   */
  discardReview(confirmedUncommittedLoss: boolean, expectedSeq: number): Promise<RpcResult<TaskSnapshot>>
}
