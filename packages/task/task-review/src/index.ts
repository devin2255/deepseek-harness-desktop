/** Task review and delivery capability. @module @deepseek-ai/dsh-task-review */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ApplyTaskReviewRequest,
  CommitTaskReviewRequest,
  DiscardTaskReviewRequest,
  GetTaskFileDiffRequest,
  SummarizeTaskReviewRequest,
  TaskApplyReceipt,
  TaskCommitReceipt,
  TaskDiscardReceipt,
  TaskFileDiff,
  TaskReviewErrorCode,
  TaskReviewSummary,
} from './types.ts'

export * from './types.ts'

/** Machine-routable Task review or delivery failure. */
export class TaskReviewError extends Error {
  /** Stable failure code suitable for Host API mapping. */
  readonly code: TaskReviewErrorCode

  /**
   * Construct one Task review failure.
   * @param message - User-safe description of the rejected operation.
   * @param code - Stable machine-routable classification.
   * @param options - Optional native error cause retained inside the Host.
   */
  constructor(message: string, code: TaskReviewErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TaskReviewError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskReview: TaskReviewService
  }
}

/** Service Definition for inspecting and delivering Task-owned worktree changes. */
export abstract class TaskReviewService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'taskReview')
  }

  /**
   * Inspect the current bounded review state of one Task worktree.
   * @param request - Recorded assignment that owns the review.
   * @param signal - Optional cancellation of repository inspection.
   * @returns One immutable summary and its exact review revision.
   */
  abstract summarize(
    request: SummarizeTaskReviewRequest,
    signal?: AbortSignal,
  ): Promise<TaskReviewSummary>

  /**
   * Read one member file diff from an exact review snapshot.
   * @param request - Recorded assignment, repository-relative path, and expected revision.
   * @param signal - Optional cancellation of diff generation.
   * @returns The bounded text or binary diff description.
   */
  abstract diff(
    request: GetTaskFileDiffRequest,
    signal?: AbortSignal,
  ): Promise<TaskFileDiff>

  /**
   * Commit the exact reviewed state inside its Task worktree.
   * @param request - Recorded assignment, expected revision, and commit message.
   * @param signal - Optional cancellation before Git commits the state.
   * @returns Durable commit facts for Session logging.
   */
  abstract commit(
    request: CommitTaskReviewRequest,
    signal?: AbortSignal,
  ): Promise<TaskCommitReceipt>

  /**
   * Apply one reviewed Task commit to its recorded source checkout.
   * @param request - Recorded assignment, expected revision, and exact Task commit.
   * @param signal - Optional cancellation before source mutation.
   * @returns Durable apply facts for Session logging.
   */
  abstract apply(
    request: ApplyTaskReviewRequest,
    signal?: AbortSignal,
  ): Promise<TaskApplyReceipt>

  /**
   * Release one Task worktree after exact-state and loss confirmation checks.
   * @param request - Recorded assignment, expected revision, and loss acknowledgement.
   * @param signal - Optional cancellation before worktree removal.
   * @returns Durable cleanup facts for Session logging.
   */
  abstract discard(
    request: DiscardTaskReviewRequest,
    signal?: AbortSignal,
  ): Promise<TaskDiscardReceipt>
}

export default TaskReviewService
