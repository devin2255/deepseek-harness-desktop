/** Client Task runtime projecting TaskManager into a public snapshot store. */

import type { Context } from '@deepseek-ai/cordis'
import type {
  DefineTaskCriterion, IApiClient, RpcResult, SessionId, TaskCriterion,
  TaskReviewDecision, TaskRisk, TaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '../contract/store.ts'
import { createSnapshotStore } from '../contract/store.ts'
import type { ITasks } from '../contract/tasks.ts'
import { TaskManager, type TaskListState } from './manager.ts'
import { TaskReviewManager, type TaskReviewState } from './review-manager.ts'

/** Client-facing Task projection and command service. */
export class TaskRuntime implements ITasks {
  readonly list: SnapshotStore<TaskListState>
  readonly reviewState: SnapshotStore<TaskReviewState>
  private readonly manager: TaskManager
  private readonly reviewManager: TaskReviewManager

  /** @param ctx - Client root context. @param api - shared typed wire client. */
  constructor(ctx: Context, api: IApiClient) {
    this.manager = new TaskManager(api)
    this.list = createSnapshotStore(this.manager.getSnapshot())
    this.manager.subscribe(() => { this.list.set(this.manager.getSnapshot()) })
    this.reviewManager = new TaskReviewManager(api, () => this.manager.refresh())
    this.reviewState = createSnapshotStore(this.reviewManager.getSnapshot())
    this.reviewManager.subscribe(() => { this.reviewState.set(this.reviewManager.getSnapshot()) })
    ctx.reflect.provide('tasks', this, undefined)
  }

  /** Refresh the Task baseline. @returns completion of the active request. */
  refresh(): Promise<void> { return this.manager.refresh() }
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
  ): Promise<RpcResult<TaskSnapshot>> {
    return this.manager.define(sessionId, goal, criteria, expectedSeq)
  }
  /** Replace a criterion. @param sessionId - root Session. @param criterion - replacement.
   * @param expectedSeq - CAS sequence. @returns command result. */
  updateCriterion(sessionId: SessionId, criterion: TaskCriterion, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.manager.updateCriterion(sessionId, criterion, expectedSeq)
  }
  /** Record a risk. @param sessionId - root Session. @param risk - replacement.
   * @param expectedSeq - CAS sequence. @returns command result. */
  recordRisk(sessionId: SessionId, risk: TaskRisk, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.manager.recordRisk(sessionId, risk, expectedSeq)
  }
  /** Record a review decision. @param sessionId - root Session. @param decision - decision.
   * @param expectedSeq - CAS sequence. @returns command result. */
  review(sessionId: SessionId, decision: TaskReviewDecision, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.manager.review(sessionId, decision, expectedSeq)
  }
  /** Open one Task review. @param sessionId - root Task. @returns completion of the read. */
  openReview(sessionId: SessionId): Promise<void> { return this.reviewManager.open(sessionId) }
  /** Refresh the open review. @returns completion of the read. */
  refreshReview(): Promise<void> { return this.reviewManager.refresh() }
  /** Select one changed file. @param path - review-relative path. @returns completion of the diff read. */
  selectReviewFile(path: string): Promise<void> { return this.reviewManager.selectFile(path) }
  /** Request Agent revisions. @param expectedSeq - Task CAS sequence. @returns command result. */
  requestChanges(expectedSeq: number): Promise<RpcResult<TaskSnapshot>> { return this.reviewManager.requestChanges(expectedSeq) }
  /** Commit the exact review. @param message - Git commit message. @param expectedSeq - Task CAS sequence. @returns command result. */
  commitReview(message: string, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.reviewManager.commit(message, expectedSeq)
  }
  /** Apply the committed review. @param commit - recorded commit. @param expectedSeq - Task CAS sequence. @returns command result. */
  applyReview(commit: string, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.reviewManager.apply(commit, expectedSeq)
  }
  /**
   * Release its worktree.
   * @param confirmedUncommittedLoss - Explicit confirmation.
   * @param expectedSeq - Task CAS sequence.
   * @returns Command result.
   */
  discardReview(confirmedUncommittedLoss: boolean, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.reviewManager.discard(confirmedUncommittedLoss, expectedSeq)
  }
  /**
   * Route one Host frame into the Task mirror.
   * @param envelope - validated Host frame.
   */
  handleHostEnvelope(envelope: Parameters<TaskManager['handleHostEnvelope']>[0]): void { this.manager.handleHostEnvelope(envelope) }
  /** Start a new connected-generation baseline pull. */
  handleConnected(): void { this.manager.handleConnected(); this.reviewManager.handleConnected() }
  /** Mark retained rows stale and invalidate the disconnected generation. */
  handleDisconnected(): void { this.manager.handleDisconnected(); this.reviewManager.handleDisconnected() }
}
