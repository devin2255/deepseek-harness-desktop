/** Connection-generation-safe Task baseline and whole-row change owner. */

import type {
  DefineTaskCriterion, HostFrame, IApiClient, RpcError, RpcRequest, RpcResult,
  SessionId, TaskCriterion, TaskListChange, TaskReviewDecision, TaskRisk, TaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import { Notifier } from '../sessions/notifier.ts'

/** Task-list arrival lifecycle. */
export type TaskListPhase = 'pending' | 'ready'

/** Whether retained rows reflect the current connected runtime generation. */
export type TaskListFreshness = 'fresh' | 'stale'

/** Immutable client Task-list snapshot. */
export interface TaskListState {
  readonly phase: TaskListPhase
  readonly state: 'idle' | 'loading' | 'error'
  readonly error: RpcError | null
  readonly freshness: TaskListFreshness
  readonly generation: number | null
  readonly ids: readonly SessionId[]
  readonly byId: Readonly<Partial<Record<SessionId, TaskSnapshot>>>
}

/** Owns Task baseline requests, generation fencing, increments, and commands. */
export class TaskManager {
  private phase: TaskListPhase = 'pending'
  private state: TaskListState['state'] = 'idle'
  private error: RpcError | null = null
  private freshness: TaskListFreshness = 'stale'
  private taskGeneration: number | null = null
  private ids: SessionId[] = []
  private byId: Partial<Record<SessionId, TaskSnapshot>> = {}
  private requestGeneration = 0
  private inflight: Promise<void> | null = null
  private refreshChanges: TaskListChange[] | null = null
  private snapshotCache: TaskListState
  private readonly notifier = new Notifier(() => { this.snapshotCache = this.buildSnapshot() })

  /** @param api - shared typed wire client. */
  constructor(private readonly api: IApiClient) {
    this.snapshotCache = this.buildSnapshot()
  }

  /** Pull the complete baseline, replaying only same-generation changes received while it was in flight. @returns the shared request. */
  refresh(): Promise<void> {
    if (this.inflight !== null) return this.inflight
    const owner = this.requestGeneration
    const changes: TaskListChange[] = []
    this.refreshChanges = changes
    this.state = 'loading'
    this.error = null
    this.notifier.markDirty()
    this.inflight = (async () => {
      try {
        const { result } = await this.api.tasks.list({})
        if (owner !== this.requestGeneration) return
        if (result.ok) {
          this.installBaseline(result.value.tasks)
          this.taskGeneration = result.value.generation
          for (const change of changes) {
            if (change.generation === this.taskGeneration) this.applyChange(change)
          }
          this.phase = 'ready'
          this.state = 'idle'
          this.freshness = 'fresh'
        } else {
          this.state = 'error'
          this.error = result.error
        }
      } catch (error: unknown) {
        if (owner !== this.requestGeneration) return
        this.state = 'error'
        const folded = transportError<never>(error)
        /* v8 ignore next -- transportError always returns the failure branch. */
        this.error = folded.ok ? null : folded.error
      } finally {
        if (owner === this.requestGeneration) {
          this.refreshChanges = null
          this.inflight = null
          this.notifier.markDirty()
        }
      }
    })()
    return this.inflight
  }

  /**
   * Accept a Host Task increment only for the active or in-flight baseline generation.
   * @param envelope - validated Host frame.
   */
  handleHostEnvelope(envelope: RpcRequest<HostFrame>): void {
    if (envelope.payload.type !== 'task/changed') return
    const change: TaskListChange = {
      generation: envelope.payload.generation,
      upserts: envelope.payload.upserts,
      removed: envelope.payload.removed,
    }
    if (this.refreshChanges !== null) this.refreshChanges.push(change)
    if (change.generation === this.taskGeneration) this.applyChange(change)
  }

  /** Re-pull the baseline after a connection generation is ready. */
  handleConnected(): void {
    void this.refresh()
  }

  /** Invalidate prior request ownership and publish retained rows as stale. */
  handleDisconnected(): void {
    this.requestGeneration += 1
    this.inflight = null
    this.refreshChanges = null
    this.taskGeneration = null
    this.state = 'loading'
    this.error = null
    this.freshness = 'stale'
    this.notifier.markDirty()
  }

  /**
   * Define or replace one Task and refresh after a successful acknowledgement.
   * @param sessionId - root Session.
   * @param goal - desired outcome.
   * @param criteria - acceptance criteria.
   * @param expectedSeq - compare-and-set sequence.
   * @returns the structured command result.
   */
  define(
    sessionId: SessionId, goal: string, criteria: readonly DefineTaskCriterion[], expectedSeq: number,
  ): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate(() => this.api.tasks.define({ sessionId, goal, criteria, expectedSeq }))
  }

  /**
   * Replace one acceptance criterion and refresh after success.
   * @param sessionId - root Session.
   * @param criterion - replacement criterion.
   * @param expectedSeq - compare-and-set sequence.
   * @returns the structured command result.
   */
  updateCriterion(sessionId: SessionId, criterion: TaskCriterion, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate(() => this.api.tasks.updateCriterion({ sessionId, criterion, expectedSeq }))
  }

  /**
   * Record or resolve one risk and refresh after success.
   * @param sessionId - root Session.
   * @param risk - replacement risk.
   * @param expectedSeq - compare-and-set sequence.
   * @returns the structured command result.
   */
  recordRisk(sessionId: SessionId, risk: TaskRisk, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate(() => this.api.tasks.recordRisk({ sessionId, risk, expectedSeq }))
  }

  /**
   * Record one review decision and refresh after success.
   * @param sessionId - root Session.
   * @param decision - review decision.
   * @param expectedSeq - compare-and-set sequence.
   * @returns the structured command result.
   */
  review(sessionId: SessionId, decision: TaskReviewDecision, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate(() => this.api.tasks.review({ sessionId, decision, expectedSeq }))
  }

  /**
   * Subscribe to snapshot invalidation.
   * @param listener - invalidation callback.
   * @returns its disposer.
   */
  subscribe(listener: () => void): () => void {
    return this.notifier.subscribe(listener)
  }

  /**
   * Read the cached snapshot after flushing pending notifications.
   * @returns the current immutable state.
   */
  getSnapshot(): TaskListState {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  private async mutate(call: () => Promise<{ result: RpcResult<TaskSnapshot> }>): Promise<RpcResult<TaskSnapshot>> {
    try {
      const { result } = await call()
      if (result.ok) await this.refresh()
      return result
    } catch (error: unknown) {
      return transportError(error)
    }
  }

  private installBaseline(tasks: readonly TaskSnapshot[]): void {
    this.ids = tasks.map(task => task.taskId)
    this.byId = Object.fromEntries(tasks.map(task => [task.taskId, task]))
  }

  private applyChange(change: TaskListChange): void {
    let changed = false
    for (const id of change.removed) {
      if (this.byId[id] === undefined) continue
      this.byId[id] = undefined
      this.ids = this.ids.filter(candidate => candidate !== id)
      changed = true
    }
    for (const task of change.upserts) {
      if (this.byId[task.taskId] === undefined) this.ids.push(task.taskId)
      this.byId[task.taskId] = task
      changed = true
    }
    if (changed) this.notifier.markDirty()
  }

  private buildSnapshot(): TaskListState {
    return {
      phase: this.phase,
      state: this.state,
      error: this.error,
      freshness: this.freshness,
      generation: this.taskGeneration,
      ids: [...this.ids],
      byId: { ...this.byId },
    }
  }
}
