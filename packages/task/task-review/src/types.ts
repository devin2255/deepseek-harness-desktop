/** Task review requests and portable results. @module @deepseek-ai/dsh-task-review/types */

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

/** Opaque identity shared by one delivery authorization and its completed receipt. */
export type TaskReviewOperationId = Branded<'TaskReviewOperationId'>

/**
 * Brand a provider-produced delivery operation identity.
 * @param value - Provider-produced normalized UUID.
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
  | 'REVIEW_INCOMPLETE'
  | 'REVIEW_INVALID_MESSAGE'
  | 'REVIEW_IDENTITY_MISSING'
  | 'REVIEW_SOURCE_DIRTY'
  | 'REVIEW_SOURCE_MOVED'
  | 'REVIEW_APPLY_CONFLICT'
  | 'REVIEW_CONFIRMATION_REQUIRED'
  | 'REVIEW_INVALID_INTEGRATION'
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
  readonly sourceHead: string
  readonly sourceDirty: boolean
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

/** Caller-owned durable authorization, awaited before changing a user index, worktree, or branch. */
export interface TaskDeliveryAuthorization<Preflight = void> {
  readonly operationId: TaskReviewOperationId
  /**
   * Persist authorization before Git changes a user index, worktree, or branch.
   * @param preflight - Provider-observed facts required by the operation; void for Apply.
   * @returns settlement permitting mutation; rejection prevents mutation.
   */
  readonly authorize: (preflight: Preflight) => Promise<void>
}

/** Current worktree facts captured before Discard authorization and removal. */
export interface TaskDiscardPreflight {
  readonly headCommit: string
  readonly uncommittedChanges: boolean
}

/** Exact parent and staged Git tree inspected before Commit authorization. */
export interface TaskCommitPreflight {
  readonly headCommit: string
  readonly tree: string
}

/** Exact user-authorized mutation retained before Git begins; absence of a receipt never authorizes replay. */
export type TaskDeliveryIntent = {
  readonly operationId: TaskReviewOperationId
  readonly reviewRevision: TaskReviewRevision
} & (
  | { readonly kind: 'commit'; readonly message: string; readonly headCommit: string; readonly tree: string }
  | { readonly kind: 'apply'; readonly commit: string; readonly sourceHead: string }
  | {
    readonly kind: 'discard'
    readonly confirmedUncommittedLoss: boolean
    readonly headCommit: string
    readonly uncommittedChanges: boolean
  }
)

/** Opaque digest of an inspected delivery result, excluding the observation timestamp. */
export type TaskDeliveryInspectionRevision = Branded<'TaskDeliveryInspectionRevision'>

/** Current Git facts consistent with a completed authorization, not a Provider execution receipt. */
export type TaskDeliveryEffect =
  | {
    readonly kind: 'commit'
    readonly commit: string
    readonly committedRevision: TaskReviewRevision
    readonly headBefore: string
    readonly tree: string
    readonly branch: string
  }
  | { readonly kind: 'apply'; readonly commit: string; readonly sourceHead: string; readonly sourceTree: string }
  | {
    readonly kind: 'discard'
    readonly branch: string
    readonly headCommit: string
    readonly worktreeRemoved: true
    readonly branchPreserved: true
    readonly uncommittedChangesDiscarded: boolean
    readonly recoverableCommit?: string
  }

/** Read-only classification; not-completed states absence now, not that Git never changed. */
export type TaskDeliveryInspection = {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly intent: TaskDeliveryIntent
  readonly revision: TaskDeliveryInspectionRevision
  readonly observedAt: number
} & (
  | { readonly status: 'completed'; readonly effect: TaskDeliveryEffect }
  | { readonly status: 'not-completed' }
  | { readonly status: 'ambiguous'; readonly reason: 'task-changed' | 'source-changed' | 'discard-incomplete' | 'state-changed' }
)

/** Recorded authorization to inspect without repeating its mutation or asserting an execution time. */
export interface InspectTaskDeliveryRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly intent: TaskDeliveryIntent
}

/** Request to commit the exact reviewed state inside the Task worktree. */
export interface CommitTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly message: string
  readonly authorization?: TaskDeliveryAuthorization<TaskCommitPreflight>
}

/** Durable facts returned after committing a Task review. */
export interface TaskCommitReceipt {
  readonly kind: 'commit'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly committedRevision: TaskReviewRevision
  readonly branch: string
  readonly commit: string
  readonly committedAt: number
}

/** Request to apply one reviewed Task commit to its recorded source checkout. */
export interface ApplyTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly expectedSourceHead: string
  readonly commit: string
  readonly authorization?: TaskDeliveryAuthorization
}

/** Durable facts returned after applying a Task commit to its source checkout. */
export interface TaskApplyReceipt {
  readonly kind: 'apply'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly commit: string
  readonly sourceHeadBefore: string
  readonly sourceHeadAfter: string
  readonly appliedAt: number
}

/** One exact committed writer result selected for integration. */
export interface TaskIntegrationInput {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly commit: string
}

/** Batch of writer commits to merge into their recorded root execution worktree. */
export interface IntegrateTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly inputs: readonly TaskIntegrationInput[]
  readonly message: string
}

/** Exact contributor identities retained by either integration outcome. */
export interface TaskIntegrationContributor {
  readonly sessionId: SessionId
  readonly branch: string
  readonly commit: string
  readonly reviewRevision: TaskReviewRevision
}

/** Successful batch integration; the user's source checkout is not changed. */
export interface TaskIntegrationReceipt {
  readonly kind: 'integrated'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly headBefore: string
  readonly headAfter: string
  readonly contributors: readonly TaskIntegrationContributor[]
  readonly integratedAt: number
}

/** Preflight conflict; root and child working trees and branches remain unchanged. */
export interface TaskIntegrationConflict {
  readonly kind: 'conflict'
  readonly operationId: TaskReviewOperationId
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly reviewRevision: TaskReviewRevision
  readonly headBefore: string
  readonly contributors: readonly TaskIntegrationContributor[]
  readonly conflictingSessionId: SessionId
  readonly paths: readonly string[]
  readonly detectedAt: number
}

/** Integration either publishes the complete batch or reports a non-mutating conflict. */
export type TaskIntegrationResult = TaskIntegrationReceipt | TaskIntegrationConflict

/** Request to release a reviewed worktree with explicit acknowledgement of dirty-data loss. */
export interface DiscardTaskReviewRequest {
  readonly assignment: TaskWorktreeAssignment
  readonly expectedRevision: TaskReviewRevision
  readonly confirmedUncommittedLoss: boolean
  readonly authorization?: TaskDeliveryAuthorization<TaskDiscardPreflight>
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
  readonly uncommittedChangesDiscarded: boolean
  readonly recoverableCommit?: string
  readonly discardedAt: number
}
