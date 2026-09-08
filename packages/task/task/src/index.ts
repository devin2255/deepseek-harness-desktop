/** Durable task facts and task projection service vocabulary. @module @deepseek-ai/dsh-task */

import type {
  TaskCriterion,
  TaskDefinition,
  TaskReviewDecision,
  TaskRisk,
} from './types.ts'

export * from './types.ts'
export * from './fold.ts'
export * from './service.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
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
  }
}
