/** Abstract Task service consumed by hosts and implemented by projection providers. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  DefineTaskRequest,
  RecordTaskRiskRequest,
  ReviewTaskRequest,
  TaskListChange,
  TaskListSnapshot,
  TaskSnapshot,
  UpdateTaskCriterionRequest,
} from './types.ts'

/** Stable business-failure taxonomy exposed by every Task Provider. */
export type TaskErrorCode =
  | 'TASK_NOT_FOUND'
  | 'TASK_TARGET_NOT_ROOT'
  | 'TASK_STALE_SEQUENCE'
  | 'TASK_INVALID_DEFINITION'
  | 'TASK_INVALID_CRITERION'
  | 'TASK_INVALID_RISK'
  | 'TASK_INVALID_REVIEW'
  | 'TASK_INVALID_EVIDENCE'
  | 'TASK_ACTIVE'
  | 'TASK_UNAVAILABLE'

/** Machine-routable Task service failure. */
export class TaskError extends Error {
  /** Stable failure code suitable for RPC mapping. */
  readonly code: TaskErrorCode

  /**
   * Construct a Task service failure.
   * @param message - human-readable failure description.
   * @param code - stable machine-routable classification.
   * @param options - optional native error cause.
   */
  constructor(message: string, code: TaskErrorCode, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TaskError'
    this.code = code
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tasks: TaskService
  }
}

/**
 * Root-task projection seam. Implementations own Session resolution, replay,
 * compare-and-set appends, live generations, and subscriber containment.
 */
export abstract class TaskService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'tasks')
  }

  /**
   * Read the current task-list baseline.
   * @returns a detached whole-list baseline for the current generation.
   */
  abstract snapshot(): TaskListSnapshot

  /**
   * Subscribe to whole-row changes.
   * @param listener - callback invoked for each committed change batch.
   * @returns a disposer that removes this exact subscription.
   */
  abstract onChanged(listener: (change: TaskListChange) => void): () => void

  /**
   * Define or replace one root Task.
   * @param sessionId - root Session identity.
   * @param request - normalized definition input and expected next sequence.
   * @returns the committed task row.
   */
  abstract define(sessionId: SessionId, request: DefineTaskRequest): Promise<TaskSnapshot>

  /**
   * Replace one criterion by stable identity.
   * @param sessionId - root Session identity.
   * @param request - complete criterion and expected next sequence.
   * @returns the committed task row.
   */
  abstract updateCriterion(sessionId: SessionId, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot>

  /**
   * Record or resolve one risk by stable identity.
   * @param sessionId - root Session identity.
   * @param request - complete risk and expected next sequence.
   * @returns the committed task row.
   */
  abstract recordRisk(sessionId: SessionId, request: RecordTaskRiskRequest): Promise<TaskSnapshot>

  /**
   * Record an explicit review or delivery decision.
   * @param sessionId - root Session identity.
   * @param request - decision and expected next sequence.
   * @returns the committed task row.
   */
  abstract review(sessionId: SessionId, request: ReviewTaskRequest): Promise<TaskSnapshot>
}

export default TaskService
