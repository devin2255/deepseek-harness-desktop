/** Durable task facts and task projection service vocabulary. @module @deepseek-ai/dsh-task */

import type {
  TaskCriterion,
  TaskDefinition,
  TaskReviewDecision,
  TaskRisk,
} from './types.ts'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree/types'
import type { TaskApplyReceipt, TaskCommitReceipt, TaskDiscardReceipt } from '@deepseek-ai/dsh-task-review/types'

export * from './types.ts'
export * from './fold.ts'
export * from './service.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Records the immutable application-owned execution worktree of one root Task.
     * @param data - complete creation-time assignment facts.
     */
    'task/worktree-assigned': { readonly assignment: TaskWorktreeAssignment }
    /**
     * Replaces the complete user-authored definition of one root task.
     * @param data - complete post-change definition.
     */
    'task/defined': { readonly definition: TaskDefinition }
    /**
     * Replaces one criterion in the current definition by stable identity.
     * @param data - complete post-change criterion.
     */
    'task/criterion-updated': { readonly criterion: TaskCriterion }
    /**
     * Replaces one durable risk by stable identity.
     * @param data - complete post-change risk.
     */
    'task/risk-recorded': { readonly risk: TaskRisk }
    /**
     * Records the current explicit review or landing decision.
     * @param data - complete post-change decision.
     */
    'task/review-decided': { readonly decision: TaskReviewDecision }
    /**
     * Records the complete receipt returned after committing reviewed Task changes.
     * @param data - provider-produced commit receipt.
     */
    'task/review-committed': { readonly receipt: TaskCommitReceipt }
    /**
     * Records the complete receipt returned after applying a Task commit to its source checkout.
     * @param data - provider-produced source-application receipt.
     */
    'task/review-applied': { readonly receipt: TaskApplyReceipt }
    /**
     * Records the complete receipt returned after removing a Task worktree.
     * @param data - provider-produced discard receipt.
     */
    'task/review-discarded': { readonly receipt: TaskDiscardReceipt }
  }
}
