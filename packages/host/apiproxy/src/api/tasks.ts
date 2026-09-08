/** Task-list baseline and compare-and-set mutation contract. */

import type {
  DefineTaskCriterion,
  TaskCriterion,
  TaskListSnapshot,
  TaskReviewDecision,
  TaskRisk,
  TaskSnapshot,
} from '@deepseek-ai/dsh-task'
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
  /** Record one explicit review or delivery decision. */
  review(request: RpcRequest<{
    sessionId: SessionId
    decision: TaskReviewDecision
    expectedSeq: number
  }>): Promise<RpcResponse<TaskSnapshot>>
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
} from '@deepseek-ai/dsh-task'
