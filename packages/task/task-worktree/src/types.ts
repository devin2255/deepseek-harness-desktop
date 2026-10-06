/** Pure data vocabulary for Task-owned execution worktrees. @module @deepseek-ai/dsh-task-worktree/types */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'

/** Stable business-failure taxonomy exposed by Task worktree Providers. */
export type TaskWorktreeErrorCode =
  | 'WORKTREE_NOT_GIT'
  | 'WORKTREE_NESTED_REPOSITORY'
  | 'WORKTREE_UNBORN_HEAD'
  | 'WORKTREE_INSUFFICIENT_SPACE'
  | 'WORKTREE_TARGET_OCCUPIED'
  | 'WORKTREE_BRANCH_OCCUPIED'
  | 'WORKTREE_GIT_FAILED'
  | 'WORKTREE_UNAVAILABLE'
  | 'WORKTREE_SOURCE_MOVED'
  | 'WORKTREE_SOURCE_DIRTY'

/** Durable facts identifying one application-owned Git worktree. */
export interface TaskWorktreeAssignment {
  readonly kind: 'git-worktree'
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly sourcePath: string
  readonly path: string
  readonly branch: string
  readonly baseCommit: string
  readonly sourceHead: string
  readonly sourceDirty: boolean
  readonly sourceStatusDigest: string
  readonly createdAt: number
}

/** Inputs required to create one application-owned execution worktree. */
export interface CreateTaskWorktreeRequest {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workspacePath: string
  /** Reject creation if the source HEAD differs from this captured commit. */
  readonly expectedSourceHead?: string
  /** Reject creation when the source has staged, unstaged, or untracked changes. */
  readonly requireCleanSource?: boolean
}

/** Live relationship between recorded assignment facts and the local Git repository. */
export type TaskWorktreeAvailability = 'available' | 'missing' | 'diverged'
