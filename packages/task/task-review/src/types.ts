/** Wire-safe values for Task review and delivery. @module @deepseek-ai/dsh-task-review/types */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Opaque identity of the exact repository state represented by one review snapshot. */
export type TaskReviewRevision = Branded<'TaskReviewRevision'>

/**
 * Brand a provider-produced review revision.
 * @param value - Stable digest or opaque revision value.
 * @returns the branded review revision.
 */
export function TaskReviewRevision(value: string): TaskReviewRevision {
  return value as TaskReviewRevision
}

/** Opaque identity of one completed delivery operation. */
export type TaskReviewOperationId = Branded<'TaskReviewOperationId'>

/**
 * Brand a provider-produced delivery operation identity.
 * @param value - Unique operation value.
 * @returns the branded operation identity.
 */
export function TaskReviewOperationId(value: string): TaskReviewOperationId {
  return value as TaskReviewOperationId
}

/** Stable business-failure taxonomy exposed by Task review Providers. */
export type TaskReviewErrorCode =
  | 'REVIEW_WORKTREE_UNAVAILABLE'
  | 'REVIEW_WORKTREE_DIVERGED'
  | 'REVIEW_STALE'
  | 'REVIEW_INVALID_PATH'
  | 'REVIEW_FILE_NOT_FOUND'
  | 'REVIEW_EMPTY'
  | 'REVIEW_IDENTITY_MISSING'
  | 'REVIEW_SOURCE_DIRTY'
  | 'REVIEW_SOURCE_MOVED'
  | 'REVIEW_APPLY_CONFLICT'
  | 'REVIEW_CONFIRMATION_REQUIRED'
  | 'REVIEW_GIT_FAILED'

/** Git-visible state of one file in a Task review. */
export type TaskReviewFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'conflicted'

/** One changed file relative to the Task worktree assignment base. */
export interface TaskReviewFile {
  readonly path: string
  readonly previousPath?: string
  readonly status: TaskReviewFileStatus
  readonly binary: boolean
  readonly additions: number | null
  readonly deletions: number | null
}

/** Bounded whole-Task review snapshot used to select files and authorize mutations. */
export interface TaskReviewSummary {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly revision: TaskReviewRevision
  readonly baseCommit: string
  readonly headCommit: string
  readonly branch: string
  readonly dirty: boolean
  readonly truncated: boolean
  readonly files: readonly TaskReviewFile[]
  readonly additions: number
  readonly deletions: number
}

/** Bounded patch for one exact file in one exact review snapshot. */
export interface TaskFileDiff {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly revision: TaskReviewRevision
  readonly path: string
  readonly previousPath?: string
  readonly binary: boolean
  readonly truncated: boolean
  readonly patch: string
}

/** Request for the current review state of one assigned Task worktree. */
export interface SummarizeTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
}

/** Request for one member file of an already displayed review snapshot. */
export interface GetTaskFileDiffRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly path: string
  readonly expectedRevision: TaskReviewRevision
}

/** Request to commit the exact reviewed state inside the Task worktree. */
export interface CommitTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly message: string
}

/** Durable facts returned after committing a Task review. */
export interface TaskCommitReceipt {
  readonly kind: 'commit'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly branch: string
  readonly commit: string
  readonly committedAt: number
}

/** Request to apply one reviewed Task commit to its recorded source checkout. */
export interface ApplyTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly commit: string
}

/** Durable facts returned after applying a Task commit to its source checkout. */
export interface TaskApplyReceipt {
  readonly kind: 'apply'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly commit: string
  readonly sourceHead: string
  readonly appliedAt: number
}

/** Request to release a reviewed worktree with explicit acknowledgement of dirty-data loss. */
export interface DiscardTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly confirmedUncommittedLoss: boolean
}

/** Durable facts returned after releasing a Task worktree. */
export interface TaskDiscardReceipt {
  readonly kind: 'discard'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly branch: string
  readonly branchPreserved: boolean
  readonly worktreeRemoved: boolean
  readonly discardedAt: number
}
