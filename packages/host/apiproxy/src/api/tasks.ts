/** Task-list baseline and compare-and-set mutation contract. */

import type {
  DefineTaskCriterion,
  TaskCriterion,
  TaskListSnapshot,
  TaskReviewDecision,
  TaskRisk,
  TaskSnapshot,
} from '@deepseek-ai/dsh-task/types'
import type {
  TaskFileDiff,
  TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RpcRequest, RpcResponse } from './rpc.ts'

/** Host RPC methods for the durable root-task projection. */
export interface TasksApi {
  /** Read the complete ordered baseline for the current task generation. */
  list(request: RpcRequest<Record<string, never>>): Promise<RpcResponse<TaskListSnapshot>>
  /** Define or replace one root task. */
  define(request: RpcRequest<{
    sessionId: SessionId
    goal: string
    criteria: readonly DefineTaskCriterion[]
    expectedSeq: number
  }>): Promise<RpcResponse<TaskSnapshot>>
  /** Replace one acceptance criterion by stable identity. */
  updateCriterion(request: RpcRequest<{
    sessionId: SessionId
    criterion: TaskCriterion
    expectedSeq: number
  }>): Promise<RpcResponse<TaskSnapshot>>
  /** Record or resolve one task risk by stable identity. */
  recordRisk(request: RpcRequest<{
    sessionId: SessionId
    risk: TaskRisk
    expectedSeq: number
  }>): Promise<RpcResponse<TaskSnapshot>>
  /** Record one explicit human review decision. */
  review(request: RpcRequest<{
    sessionId: SessionId
    decision: TaskReviewDecision
    expectedSeq: number
  }>): Promise<RpcResponse<TaskSnapshot>>
  /** Inspect the complete bounded review summary for one assigned Task. */
  reviewSummary(request: RpcRequest<{ sessionId: SessionId }>, signal: AbortSignal): Promise<RpcResponse<TaskReviewSummary>>
  /** Read one bounded file diff from an exact Task review revision. */
  reviewDiff(request: RpcRequest<{
    sessionId: SessionId
    path: string
    expectedRevision: string
  }>, signal: AbortSignal): Promise<RpcResponse<TaskFileDiff>>
  /** Commit one exact ready Task review and record its receipt. */
  commit(request: RpcRequest<{
    sessionId: SessionId
    expectedRevision: string
    message: string
    expectedSeq: number
  }>, signal: AbortSignal): Promise<RpcResponse<TaskSnapshot>>
  /** Apply one exact Task commit to its source checkout and record its receipt. */
  apply(request: RpcRequest<{
    sessionId: SessionId
    expectedRevision: string
    expectedSourceHead: string
    commit: string
    expectedSeq: number
  }>, signal: AbortSignal): Promise<RpcResponse<TaskSnapshot>>
  /** Remove one exact Task worktree and record its recovery facts. */
  discard(request: RpcRequest<{
    sessionId: SessionId
    expectedRevision: string
    confirmedUncommittedLoss: boolean
    expectedSeq: number
  }>, signal: AbortSignal): Promise<RpcResponse<TaskSnapshot>>
}

export type {
  AttentionItem,
  DefineTaskCriterion,
  TaskCriterion,
  TaskDefinition,
  TaskEvidenceRef,
  TaskListChange,
  TaskListSnapshot,
  TaskReviewDecision,
  TaskRisk,
  TaskSnapshot,
} from '@deepseek-ai/dsh-task/types'
export type {
  TaskApplyReceipt,
  TaskCommitReceipt,
  TaskDiscardReceipt,
  TaskFileDiff,
  TaskReviewFile,
  TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review/types'
