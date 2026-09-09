/** Task-owned execution worktree capability. @module @deepseek-ai/dsh-task-worktree */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

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

/** Machine-routable Task worktree failure. */
export class TaskWorktreeError extends Error {
  /** Stable failure code suitable for Host API mapping. */
  readonly code: TaskWorktreeErrorCode

  /**
   * Construct one Task worktree failure.
   * @param message - User-safe description of the rejected operation.
   * @param code - Stable machine-routable classification.
   * @param options - Optional native error cause retained inside the Host.
   */
  constructor(message: string, code: TaskWorktreeErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TaskWorktreeError'
    this.code = code
  }
}

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

/** Inputs required to create one Task's integration worktree. */
export interface CreateTaskWorktreeRequest {
  readonly taskId: SessionId
  readonly workspaceId: WorkspaceId
  readonly workspacePath: string
}

/** Live relationship between recorded assignment facts and the local Git repository. */
export type TaskWorktreeAvailability = 'available' | 'missing' | 'diverged'

declare module '@deepseek-ai/cordis' {
  interface Context {
    taskWorktrees: TaskWorktreeService
  }
}

/** Service Definition for Task-specific execution worktrees. */
export abstract class TaskWorktreeService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'taskWorktrees')
  }

  /**
   * Create one application-owned integration worktree without changing the source checkout.
   * @param request - Task identity and registered source Workspace.
   * @param signal - Optional cancellation of inspection and Git execution.
   * @returns Complete assignment facts suitable for durable Session logging.
   */
  abstract create(
    request: CreateTaskWorktreeRequest,
    signal?: AbortSignal,
  ): Promise<TaskWorktreeAssignment>

  /**
   * Compare durable assignment facts with the current local Git registration.
   * @param assignment - Previously recorded worktree assignment.
   * @param signal - Optional cancellation of Git inspection.
   * @returns Whether the exact worktree remains available, is missing, or has diverged.
   */
  abstract inspect(
    assignment: TaskWorktreeAssignment,
    signal?: AbortSignal,
  ): Promise<TaskWorktreeAvailability>
}

export default TaskWorktreeService
