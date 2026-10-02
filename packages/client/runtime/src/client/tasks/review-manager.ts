/** Connection-safe Task review state and delivery command owner. */

import type {
  IApiClient, RpcError, RpcResult, SessionId, TaskFileDiff, TaskReviewSummary, TaskSnapshot,
} from '@deepseek-ai/dsh-api-remotes/client'
import { transportError } from '@deepseek-ai/dsh-host-apiproxy/api'
import { Notifier } from '../sessions/notifier.ts'

/** Review read and delivery operation currently visible to the user. */
export type TaskReviewOperation = 'request-changes' | 'commit' | 'apply' | 'discard'

/** Immutable state for the separate Task Review workspace. */
export interface TaskReviewState {
  readonly taskId: SessionId | undefined
  readonly state: 'idle' | 'loading' | 'ready' | 'error'
  readonly diffState: 'idle' | 'loading' | 'ready' | 'error'
  readonly freshness: 'fresh' | 'stale'
  readonly summary: TaskReviewSummary | null
  readonly selectedPath: string | undefined
  readonly diff: TaskFileDiff | null
  readonly error: RpcError | null
  readonly operation: TaskReviewOperation | null
  readonly result: TaskSnapshot | null
}

/** Owns one visible Task review, selection, bounded diff, and serialized delivery mutations. */
export class TaskReviewManager {
  private taskId: SessionId | undefined
  private state: TaskReviewState['state'] = 'idle'
  private diffState: TaskReviewState['diffState'] = 'idle'
  private freshness: TaskReviewState['freshness'] = 'stale'
  private summary: TaskReviewSummary | null = null
  private selectedPath: string | undefined
  private diff: TaskFileDiff | null = null
  private error: RpcError | null = null
  private operation: TaskReviewOperation | null = null
  private result: TaskSnapshot | null = null
  private requestGeneration = 0
  private diffGeneration = 0
  private inflight: Promise<void> | null = null
  private snapshotCache: TaskReviewState
  private readonly notifier = new Notifier(() => { this.snapshotCache = this.buildSnapshot() })

  /** @param api - typed Host wire client. @param refreshTasks - refreshes the durable Task projection after mutations. */
  constructor(private readonly api: IApiClient, private readonly refreshTasks: () => Promise<void>) {
    this.snapshotCache = this.buildSnapshot()
  }

  /**
   * Select a Task and load its review package.
   * @param taskId - Isolated root Task.
   * @returns Completion of the read.
   */
  open(taskId: SessionId): Promise<void> {
    if (this.taskId !== taskId) {
      this.requestGeneration += 1
      this.diffGeneration += 1
      this.inflight = null
      this.taskId = taskId
      this.summary = null
      this.selectedPath = undefined
      this.diff = null
      this.diffState = 'idle'
      this.result = null
    }
    return this.refresh()
  }

  /** Refresh the selected Task summary and its retained file selection. @returns completion of summary and initial diff reads. */
  refresh(): Promise<void> {
    const taskId = this.taskId
    if (taskId === undefined) return Promise.resolve()
    if (this.inflight !== null) return this.inflight
    const owner = this.requestGeneration
    this.state = 'loading'
    this.error = null
    this.notifier.markDirty()
    this.inflight = (async () => {
      try {
        const { result } = await this.api.tasks.reviewSummary({ sessionId: taskId })
        if (owner !== this.requestGeneration) return
        if (!result.ok) {
          this.state = 'error'
          this.error = result.error
          return
        }
        this.summary = result.value
        this.freshness = 'fresh'
        this.state = 'ready'
        this.selectedPath = result.value.files.some(file => file.path === this.selectedPath)
          ? this.selectedPath
          : result.value.files[0]?.path
        this.diff = null
        this.diffState = this.selectedPath === undefined ? 'idle' : 'loading'
        this.notifier.markDirty()
        if (this.selectedPath !== undefined) await this.loadDiff(this.selectedPath, result.value, owner)
      } catch (error: unknown) {
        if (owner !== this.requestGeneration) return
        this.state = 'error'
        this.error = errorResult(error).error
      } finally {
        if (owner === this.requestGeneration) {
          this.inflight = null
          this.notifier.markDirty()
        }
      }
    })()
    return this.inflight
  }

  /**
   * Select and load one file from the current exact summary.
   * @param path - Summary member path.
   * @returns Completion of the diff read.
   */
  selectFile(path: string): Promise<void> {
    const summary = this.summary
    if (summary === null || !summary.files.some(file => file.path === path)) {
      return Promise.reject(new Error(`Task review file is unavailable: ${path}`))
    }
    this.selectedPath = path
    this.diff = null
    this.diffState = 'loading'
    this.error = null
    this.notifier.markDirty()
    return this.loadDiff(path, summary, this.requestGeneration)
  }

  /**
   * Request another Agent revision.
   * @param expectedSeq - Task CAS sequence.
   * @returns Structured command result.
   */
  requestChanges(expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate('request-changes', taskId => this.api.tasks.review({
      sessionId: taskId, decision: 'changes-requested', expectedSeq,
    }), true)
  }

  /**
   * Commit the exact visible review.
   * @param message - Git commit message.
   * @param expectedSeq - Task CAS sequence.
   * @returns Command result.
   */
  commit(message: string, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate('commit', (taskId, summary) => this.api.tasks.commit({
      sessionId: taskId, expectedRevision: summary.revision, message, expectedSeq,
    }), true)
  }

  /**
   * Apply a committed review into its clean source checkout.
   * @param commit - Recorded Task commit.
   * @param expectedSeq - Task CAS sequence.
   * @returns Command result.
   */
  apply(commit: string, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate('apply', (taskId, summary) => this.api.tasks.apply({
      sessionId: taskId, expectedRevision: summary.revision,
      expectedSourceHead: summary.sourceHead, commit, expectedSeq,
    }), false)
  }

  /**
   * Release the Task worktree.
   * @param confirmedUncommittedLoss - Explicit dirty-data confirmation.
   * @param expectedSeq - Task CAS sequence.
   * @returns Command result.
   */
  discard(confirmedUncommittedLoss: boolean, expectedSeq: number): Promise<RpcResult<TaskSnapshot>> {
    return this.mutate('discard', (taskId, summary) => this.api.tasks.discard({
      sessionId: taskId, expectedRevision: summary.revision, confirmedUncommittedLoss, expectedSeq,
    }), false)
  }

  /** Retain the visible review as stale and invalidate prior reads. */
  handleDisconnected(): void {
    this.requestGeneration += 1
    this.diffGeneration += 1
    this.inflight = null
    this.state = this.taskId === undefined ? 'idle' : 'loading'
    this.diffState = this.diff === null ? 'idle' : 'ready'
    this.freshness = 'stale'
    this.operation = null
    this.notifier.markDirty()
  }

  /** Re-read an open review after transport reconnection. */
  handleConnected(): void {
    if (this.taskId !== undefined) void this.refresh()
  }

  /**
   * Subscribe to review snapshot invalidation.
   * @param listener - Callback.
   * @returns Disposer.
   */
  subscribe(listener: () => void): () => void { return this.notifier.subscribe(listener) }

  /**
   * Read the cached review state.
   * @returns Immutable snapshot.
   */
  getSnapshot(): TaskReviewState {
    this.notifier.ensureFresh()
    return this.snapshotCache
  }

  private async loadDiff(path: string, summary: TaskReviewSummary, requestOwner: number): Promise<void> {
    const owner = ++this.diffGeneration
    try {
      const { result } = await this.api.tasks.reviewDiff({
        sessionId: summary.taskId, path, expectedRevision: summary.revision,
      })
      if (requestOwner !== this.requestGeneration || owner !== this.diffGeneration || path !== this.selectedPath) return
      if (result.ok) {
        this.diff = result.value
        this.diffState = 'ready'
      } else {
        this.diffState = 'error'
        this.error = result.error
      }
    } catch (error: unknown) {
      if (requestOwner !== this.requestGeneration || owner !== this.diffGeneration || path !== this.selectedPath) return
      this.diffState = 'error'
      this.error = errorResult(error).error
    } finally {
      if (requestOwner === this.requestGeneration && owner === this.diffGeneration) this.notifier.markDirty()
    }
  }

  private async mutate(
    operation: TaskReviewOperation,
    call: (taskId: SessionId, summary: TaskReviewSummary) => Promise<{ result: RpcResult<TaskSnapshot> }>,
    refreshReview: boolean,
  ): Promise<RpcResult<TaskSnapshot>> {
    const taskId = this.taskId
    const summary = this.summary
    if (taskId === undefined || summary === null) {
      const unavailable: RpcResult<TaskSnapshot> = { ok: false, error: {
        code: 'task-review-unavailable', message: 'Task review is not loaded.', details: { sessionId: taskId ?? ('' as SessionId) },
      } }
      this.error = unavailable.error
      this.notifier.markDirty()
      return unavailable
    }
    this.operation = operation
    this.error = null
    this.notifier.markDirty()
    let result: RpcResult<TaskSnapshot>
    try {
      result = (await call(taskId, summary)).result
    } catch (error: unknown) {
      result = errorResult(error)
    }
    if (result.ok) {
      this.result = result.value
      await this.refreshTasks()
      if (refreshReview) await this.refresh()
    } else {
      this.error = result.error
    }
    this.operation = null
    this.notifier.markDirty()
    return result
  }

  private buildSnapshot(): TaskReviewState {
    return {
      taskId: this.taskId, state: this.state, diffState: this.diffState, freshness: this.freshness,
      summary: this.summary, selectedPath: this.selectedPath, diff: this.diff, error: this.error,
      operation: this.operation, result: this.result,
    }
  }
}

function errorResult(error: unknown): Extract<RpcResult<never>, { ok: false }> {
  const result = transportError<never>(error)
  /* v8 ignore next -- transportError always returns the failure branch. */
  return result.ok ? { ok: false, error: { code: 'internal', message: 'Unknown transport error', details: {} } } : result
}
