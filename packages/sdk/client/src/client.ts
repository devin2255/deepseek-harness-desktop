/**
 * Low-level JSON-RPC client for a DeepSeek Harness SDK runtime subprocess.
 * {@link HarnessClient} owns the child process: it spawns the runtime, speaks
 * the `@deepseek-ai/dsh-sdk-protocol` wire over the child's stdio, fans
 * server notifications out to subscriptions, and tears the child down to
 * quiescence through a private EOF → SIGTERM → SIGKILL ladder. The design
 * twin is the Python SDK's `HarnessClient` (`python/sdk`); both drive the
 * same runtime protocol. This client runs OUTSIDE any harness context, so it
 * spawns directly rather than through the `dsh-subprocess` service — the
 * seam's documented exception for SDK-managed transports.
 *
 * @module @deepseek-ai/dsh-sdk-client/client
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  JsonRpcLineTransport,
  JsonRpcResponseError,
  type InitializeParams,
  type InitializeResult,
  type SessionPromptParams,
} from '@deepseek-ai/dsh-sdk-protocol'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {
  DefineTaskRequest, RecordTaskRiskRequest, ReviewTaskRequest, TaskListSnapshot,
  TaskSnapshot, UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task/types'
import type { TaskFileDiff, TaskReviewSummary } from '@deepseek-ai/dsh-task-review/types'
import { disposeRuntimeProcess } from './dispose.ts'
import type {
  ApplyTaskRequest, CommitTaskRequest, DiscardTaskRequest, GetTaskReviewDiffRequest,
  HarnessClientOptions, HarnessNotification, NotificationFilter,
} from './types.ts'

/** Retained stderr lines used to diagnose an unexpected runtime death. */
const STDERR_TAIL_LIMIT = 400

/** Grace for the runtime's stdio streams to settle after its exit edge. */
const STREAM_SETTLE_MS = 100

/**
 * The runtime subprocess is gone or unusable: it exited, its stdio closed, or
 * it was never launchable. The message carries the exit code and a stderr
 * tail when available.
 */
export class TransportClosedError extends Error {
  /** @param message - the failure description, including any stderr tail. */
  constructor(message: string) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

/** A request exceeded {@link HarnessClientOptions.requestTimeoutMs}. */
export class RequestTimeoutError extends Error {
  /** @param message - which method timed out. */
  constructor(message: string) {
    super(message)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * The runtime answered outside its documented protocol (for example a
 * `session/prompt` response without `accepted: true`).
 */
export class SdkProtocolError extends Error {
  /** @param message - the protocol violation description. */
  constructor(message: string) {
    super(message)
    this.name = 'SdkProtocolError'
  }
}

interface SubscriptionState {
  readonly queue: HarnessNotification[]
  readonly waiters: { resolve: (item: HarnessNotification) => void; reject: (error: Error) => void }[]
  readonly filter: NotificationFilter | undefined
  failure: Error | undefined
}

/** One client-side notification stream returned by {@link HarnessClient.subscribe}. */
export interface NotificationSubscription extends AsyncIterable<HarnessNotification> {
  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification>

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void
}

/** Internal producer side of a public notification subscription. */
class NotificationSubscriptionImpl implements NotificationSubscription {
  constructor(
    private readonly state: SubscriptionState,
    private readonly unsubscribe: () => void,
  ) {}

  /**
   * Await the next matching notification.
   * @returns the notification; after the runtime died, drains what was
   * already delivered and then rejects; after {@link close}, rejects
   * immediately (the queue is dropped).
   */
  next(): Promise<HarnessNotification> {
    const queued = this.state.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.state.failure !== undefined) return Promise.reject(this.state.failure)
    return new Promise((resolve, reject) => {
      this.state.waiters.push({ resolve, reject })
    })
  }

  /**
   * Drain one already-delivered notification without waiting.
   * @returns the next queued notification, or `undefined` when none is queued.
   */
  tryNext(): HarnessNotification | undefined {
    return this.state.queue.shift()
  }

  /** Detach from the client; queued items drop and pending waiters reject. */
  close(): void {
    this.unsubscribe()
    // The drop is part of this method's contract; a runtime-death fail() keeps
    // the queue so already-delivered notifications remain drainable.
    this.state.queue.length = 0
    this.fail(new TransportClosedError('notification subscription closed'))
  }

  /**
   * Reject pending and future waits (delivery stops; the first failure wins).
   * Already-queued notifications remain drainable via {@link next}/{@link tryNext}.
   * @param error - the terminal failure delivered to waiters.
   */
  fail(error: Error): void {
    this.state.failure ??= error
    for (const waiter of this.state.waiters.splice(0)) waiter.reject(this.state.failure)
  }

  /**
   * Deliver one notification to a waiter or the queue when the filter
   * matches. A throwing filter fails only THIS subscription (detached, the
   * throw becomes its terminal error) — it never disturbs sibling
   * subscriptions or the transport's read loop, mirroring the Python client.
   * @param notification - the wire notification to deliver.
   */
  push(notification: HarnessNotification): void {
    let matches: boolean
    try {
      matches = this.state.filter === undefined || this.state.filter(notification)
    } catch (error) {
      this.unsubscribe()
      this.fail(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (!matches) return
    const waiter = this.state.waiters.shift()
    if (waiter !== undefined) waiter.resolve(notification)
    else this.state.queue.push(notification)
  }

  /**
   * Iterate notifications until the subscription or runtime closes (the
   * terminating rejection propagates).
   * @returns an async iterator over {@link next} results.
   */
  async * [Symbol.asyncIterator](): AsyncIterator<HarnessNotification> {
    for (;;) yield await this.next()
  }
}

/**
 * JSON-RPC client for the DeepSeek Harness SDK runtime over subprocess stdio.
 *
 * The subprocess starts lazily on {@link start} and is owned by this instance
 * until {@link close}, which requests protocol `shutdown` and then walks the
 * shared EOF → SIGTERM → SIGKILL dispose ladder to quiescence. There is no
 * wire-level cancel: a timed-out request stays running server-side until the
 * runtime is closed.
 */
export class HarnessClient {
  private child: ChildProcess | undefined
  private transport: JsonRpcLineTransport | undefined
  private readonly stderrTail: string[] = []
  private readonly subscriptions = new Map<string, NotificationSubscriptionImpl>()
  private readonly sessionParents = new Map<string, string>()
  private subscriptionSerial = 0
  private exitCode: number | null | undefined
  private spawnError: Error | undefined
  private streamsSettled: Promise<void> = Promise.resolve()
  private closeTask: Promise<void> | undefined

  /** @param options - launch spec, complete child environment, and timeouts. */
  constructor(readonly options: HarnessClientOptions) {}

  /**
   * Spawn the runtime subprocess and start reading frames. Idempotent while
   * the process is live; rejects reuse after {@link close}.
   */
  start(): void {
    if (this.closeTask !== undefined) throw new TransportClosedError('DeepSeek Harness runtime client is closed')
    if (this.child !== undefined) return
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.once('error', (error) => {
      this.spawnError = error
      // A spawn failure destroys the pipes without an input 'end' edge, so the
      // transport's pending requests must be failed here.
      this.transport?.close()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime failed to start'))
    })
    // Writes racing the runtime's death EPIPE on stdin; the exit edge below is
    // the real signal, so the stream-level error only needs to be non-fatal.
    // The timing of that race is not deterministically reproducible.
    /* v8 ignore next */
    child.stdin.on('error', () => {})
    let stderrBuffer = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderrBuffer += chunk
      const newline = stderrBuffer.lastIndexOf('\n')
      if (newline >= 0) {
        this.appendStderr(stderrBuffer.slice(0, newline).split('\n'))
        stderrBuffer = stderrBuffer.slice(newline + 1)
      }
    })
    let signalStreamsSettled!: () => void
    this.streamsSettled = new Promise((resolve) => { signalStreamsSettled = resolve })
    const settled = { stderr: false, exited: false }
    const maybeSettle = (): void => {
      if (settled.stderr && settled.exited) signalStreamsSettled()
    }
    child.stderr.once('close', () => {
      if (stderrBuffer.length > 0) this.appendStderr([stderrBuffer])
      settled.stderr = true
      maybeSettle()
    })
    child.once('exit', (code) => {
      this.exitCode = code
      settled.exited = true
      maybeSettle()
      this.failSubscriptions(this.closedError('DeepSeek Harness runtime exited'))
    })
    child.once('close', () => {
      // All stdio has settled: stdout 'end' already drained every tail frame,
      // so closing now cannot drop responses — it only fails requests that
      // will never be answered.
      this.transport?.close()
    })
    const transport = new JsonRpcLineTransport(child.stdout, child.stdin)
    transport.onNotification((method, params) => { this.dispatchNotification({ method, params }) })
    transport.start()
    this.transport = transport
  }

  /**
   * Perform the process-wide handshake.
   * @param params - workspace cwd plus the provider/model route.
   * @returns the runtime's wire identity.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    const result = await this.request('initialize', { ...params })
    if (!isRecord(result) || !isRecord(result.serverInfo)
      || typeof result.serverInfo.name !== 'string' || typeof result.serverInfo.version !== 'string') {
      throw new SdkProtocolError(`initialize returned no server identity: ${JSON.stringify(result)}`)
    }
    return { serverInfo: { name: result.serverInfo.name, version: result.serverInfo.version } }
  }

  /**
   * Queue one prompt and return its durable inbox identity.
   * @param sessionId - target session; an unknown id creates it.
   * @param contentBlocks - the user message, sent verbatim.
   * @returns the queued message id.
   */
  async prompt(sessionId: string, contentBlocks: ContentBlock[]): Promise<string> {
    const params: SessionPromptParams = { sessionId, contentBlocks }
    const result = await this.request('session/prompt', { ...params })
    if (!isRecord(result) || typeof result.messageId !== 'string') {
      throw new SdkProtocolError(`session/prompt returned no message id: ${JSON.stringify(result)}`)
    }
    return result.messageId
  }

  /**
   * Read the complete detached Task baseline.
   * @returns the validated Task list.
   */
  async listTasks(): Promise<TaskListSnapshot> {
    const result = await this.request('task/list')
    if (!isRecord(result) || !Number.isSafeInteger(result.generation) || !Array.isArray(result.tasks)) {
      throw new SdkProtocolError(`task/list returned a malformed baseline: ${JSON.stringify(result)}`)
    }
    return { generation: result.generation as number, tasks: result.tasks.map(decodeTaskSnapshot) }
  }

  /**
   * Define or replace a root Task.
   * @param sessionId - root Session.
   * @param request - Task definition command.
   * @returns the committed Task.
   */
  async defineTask(sessionId: string, request: DefineTaskRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/define', { sessionId, ...request }))
  }

  /**
   * Replace one Task criterion.
   * @param sessionId - root Session.
   * @param request - criterion command.
   * @returns the committed Task.
   */
  async updateTaskCriterion(sessionId: string, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/updateCriterion', { sessionId, ...request }))
  }

  /**
   * Record or resolve one Task risk.
   * @param sessionId - root Session.
   * @param request - risk command.
   * @returns the committed Task.
   */
  async recordTaskRisk(sessionId: string, request: RecordTaskRiskRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/recordRisk', { sessionId, ...request }))
  }

  /**
   * Record one Task review decision.
   * @param sessionId - root Session.
   * @param request - review command.
   * @returns the committed Task.
   */
  async reviewTask(sessionId: string, request: ReviewTaskRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/review', { sessionId, ...request }))
  }

  /**
   * Load one assigned Task's bounded review summary.
   * @param sessionId - root Session.
   * @returns the validated review summary.
   */
  async getTaskReviewSummary(sessionId: string): Promise<TaskReviewSummary> {
    return decodeTaskReviewSummary(await this.request('task/reviewSummary', { sessionId }))
  }

  /**
   * Load one file from an exact Task review snapshot.
   * @param sessionId - root Session.
   * @param request - exact revision and repository-relative file path.
   * @returns the validated bounded file diff.
   */
  async getTaskReviewDiff(sessionId: string, request: GetTaskReviewDiffRequest): Promise<TaskFileDiff> {
    return decodeTaskFileDiff(await this.request('task/reviewDiff', { sessionId, ...request }))
  }

  /**
   * Commit one exact ready Task review inside its isolated worktree.
   * @param sessionId - root Session.
   * @param request - commit message, exact review revision, and Task sequence.
   * @returns the Task carrying its durable commit receipt.
   */
  async commitTask(sessionId: string, request: CommitTaskRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/commit', { sessionId, ...request }))
  }

  /**
   * Apply one recorded Task commit to its source checkout.
   * @param sessionId - root Session.
   * @param request - exact commit, review revision, source head, and Task sequence.
   * @returns the Task carrying its durable apply receipt.
   */
  async applyTask(sessionId: string, request: ApplyTaskRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/apply', { sessionId, ...request }))
  }

  /**
   * Explicitly release one Task worktree.
   * @param sessionId - root Session.
   * @param request - exact revision, loss confirmation, and Task sequence.
   * @returns the Task carrying its durable discard receipt.
   */
  async discardTask(sessionId: string, request: DiscardTaskRequest): Promise<TaskSnapshot> {
    return decodeTaskSnapshot(await this.request('task/discard', { sessionId, ...request }))
  }

  /**
   * Send one JSON-RPC request and await its result.
   * @param method - the wire method name.
   * @param params - the params object; omitted params send `{}`.
   * @param timeoutMs - per-call override of {@link HarnessClientOptions.requestTimeoutMs}.
   * @returns the raw result; rejects with {@link JsonRpcResponseError} on a
   * protocol error response, {@link RequestTimeoutError} on timeout, and
   * {@link TransportClosedError} when the runtime is gone.
   */
  async request(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    this.start()
    // A dead runtime cannot answer; fail with process context instead of
    // writing into a destroyed pipe and hanging until the timeout.
    if (this.exitCode !== undefined || this.spawnError !== undefined) {
      await this.settleStreams()
      throw this.closedError('DeepSeek Harness runtime is not running')
    }
    const transport = this.transport
    /* v8 ignore next -- start() either sets the transport or throws */
    if (transport === undefined) throw new TransportClosedError('DeepSeek Harness runtime is not running')
    const timeout = timeoutMs ?? this.options.requestTimeoutMs
    try {
      if (timeout === undefined) return await transport.request(method, params ?? {})
      // The abort signal makes the timeout an abandonment: the transport drops
      // its pending entry, so repeated bounded requests against a hung method
      // retain no per-call state (the server-side work still runs to close).
      const abandon = new AbortController()
      const timer = setTimeout(() => {
        abandon.abort(new RequestTimeoutError(`${method} timed out after ${timeout}ms waiting for the DeepSeek Harness runtime`))
      }, timeout)
      try {
        return await transport.request(method, params ?? {}, abandon.signal)
      } finally {
        clearTimeout(timer)
      }
    } catch (error) {
      if (error instanceof JsonRpcResponseError || error instanceof RequestTimeoutError) throw error
      // Transport-level failures gain process context: exit code + stderr tail.
      await this.settleStreams()
      throw this.closedError(errorMessage(error))
    }
  }

  /**
   * Subscribe to server notifications.
   * @param filter - optional predicate; omitted means every notification.
   * @returns the subscription handle; close it to stop delivery. After
   * {@link close} or runtime death the handle is born failed — there is no
   * producer left, so `next()` rejects instead of waiting forever.
   */
  subscribe(filter?: NotificationFilter): NotificationSubscription {
    const id = String(this.subscriptionSerial++)
    const state: SubscriptionState = { queue: [], waiters: [], filter, failure: undefined }
    const subscription = new NotificationSubscriptionImpl(state, () => { this.subscriptions.delete(id) })
    if (this.closeTask !== undefined || this.exitCode !== undefined || this.spawnError !== undefined) {
      subscription.fail(this.closedError('DeepSeek Harness runtime closed'))
      return subscription
    }
    this.subscriptions.set(id, subscription)
    return subscription
  }

  /**
   * Subscribe to one session and the descendants discovered from
   * `subagent.started` lineage edges (the runtime notifies for every session
   * in its context; scoping is client-side, mirroring the Python SDK).
   * @param sessionId - the root session id.
   * @returns the filtered subscription handle.
   */
  subscribeSessionTree(sessionId: string): NotificationSubscription {
    return this.subscribe((notification) => {
      const params = notification.params
      if (notification.method === 'subagent.started' || notification.method === 'subagent.finished') {
        const parentId = params.parentSessionId
        if (typeof parentId === 'string' && this.isDescendantOf(parentId, sessionId)) return true
        return params.childSessionId === sessionId
      }
      const relatedId = params.sessionId
      return typeof relatedId === 'string' && this.isDescendantOf(relatedId, sessionId)
    })
  }

  /**
   * Shut the runtime down and reap it: a best-effort protocol `shutdown`
   * bounded by `shutdownTimeoutMs`, then the shared stdin-EOF → SIGTERM →
   * SIGKILL ladder until the process actually exited. Idempotent.
   * @returns settlement of the complete teardown.
   */
  close(): Promise<void> {
    this.closeTask ??= this.performClose()
    return this.closeTask
  }

  private async performClose(): Promise<void> {
    const child = this.child
    if (child === undefined) return
    try {
      await this.request('shutdown', undefined, this.options.shutdownTimeoutMs ?? 1_000)
    } catch (error) {
      // Diagnostic only: the dispose ladder below is the authoritative teardown
      // for a runtime that cannot answer shutdown anymore.
      this.appendStderr([`shutdown request failed: ${errorMessage(error)}`])
    }
    await disposeRuntimeProcess(child, {
      disposeEofGraceMs: this.options.disposeEofGraceMs ?? 6_000,
      disposeGraceMs: this.options.disposeGraceMs ?? 3_000,
    })
    this.transport?.close()
    this.failSubscriptions(this.closedError('DeepSeek Harness runtime closed'))
  }

  private dispatchNotification(notification: HarnessNotification): void {
    this.recordSessionRelationship(notification)
    for (const subscription of this.subscriptions.values()) subscription.push(notification)
  }

  private recordSessionRelationship(notification: HarnessNotification): void {
    if (notification.method !== 'subagent.started') return
    const parentId = notification.params.parentSessionId
    const childId = notification.params.childSessionId
    if (typeof parentId === 'string' && parentId !== '' && typeof childId === 'string' && childId !== '' && parentId !== childId) {
      this.sessionParents.set(childId, parentId)
    }
  }

  private isDescendantOf(sessionId: string, rootSessionId: string): boolean {
    const visited = new Set<string>()
    let current = sessionId
    while (!visited.has(current)) {
      if (current === rootSessionId) return true
      visited.add(current)
      const parent = this.sessionParents.get(current)
      if (parent === undefined) return false
      current = parent
    }
    // The parent map only ever extends chains upward, so a cycle cannot form.
    /* v8 ignore next */
    return false
  }

  private failSubscriptions(error: Error): void {
    for (const subscription of this.subscriptions.values()) subscription.fail(error)
  }

  private appendStderr(lines: string[]): void {
    const kept = lines.filter(line => line.length > 0)
    this.stderrTail.push(...kept)
    if (this.stderrTail.length > STDERR_TAIL_LIMIT) {
      this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LIMIT)
    }
  }

  private settleStreams(): Promise<void> {
    return Promise.race([
      this.streamsSettled,
      new Promise<void>((resolve) => { setTimeout(resolve, STREAM_SETTLE_MS) }),
    ])
  }

  private closedError(reason: string): TransportClosedError {
    const parts = [reason]
    if (this.spawnError !== undefined) parts.push(`spawn error: ${this.spawnError.message}`)
    if (this.exitCode !== undefined) parts.push(`exit code: ${String(this.exitCode)}`)
    if (this.stderrTail.length > 0) parts.push(`stderr tail:\n${this.stderrTail.join('\n')}`)
    return new TransportClosedError(parts.join('\n'))
  }
}

/**
 * Whether `value` is a plain JSON object (the wire-boundary shape probe).
 * @param value - the wire value to probe.
 * @returns `true` iff `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate the required fields of one detached Task projection. */
function decodeTaskSnapshot(value: unknown): TaskSnapshot {
  if (!isRecord(value)
    || typeof value.taskId !== 'string'
    || !Array.isArray(value.descendantSessionIds)
    || !value.descendantSessionIds.every(id => typeof id === 'string')
    || !['needs-attention', 'failed', 'running', 'reviewing', 'ready', 'settled'].includes(String(value.status))
    || !['live', 'disconnected', 'unavailable'].includes(String(value.freshness))
    || !Array.isArray(value.attention)
    || !Array.isArray(value.risks)
    || typeof value.updatedAt !== 'number'
    || !Number.isSafeInteger(value.asOfSeq)) {
    throw new SdkProtocolError(`Task response carried a malformed row: ${JSON.stringify(value)}`)
  }
  if (value.executionWorkspace !== undefined
    && !isTaskWorktreeAssignment(value.executionWorkspace, value.taskId, value.workspaceId)) {
    throw new SdkProtocolError(`Task response carried a malformed row: ${JSON.stringify(value)}`)
  }
  if (value.reviewDecision !== undefined
    && (typeof value.reviewDecision !== 'string' || !['changes-requested', 'ready'].includes(value.reviewDecision))) {
    throw new SdkProtocolError(`Task response carried a malformed row: ${JSON.stringify(value)}`)
  }
  if (value.commitReceipt !== undefined && !isCommitReceipt(value.commitReceipt, value.taskId, value.workspaceId)) {
    throw new SdkProtocolError(`Task response carried a malformed row: ${JSON.stringify(value)}`)
  }
  if (value.applyReceipt !== undefined && !isApplyReceipt(value.applyReceipt, value.taskId, value.workspaceId)) {
    throw new SdkProtocolError(`Task response carried a malformed row: ${JSON.stringify(value)}`)
  }
  if (value.discardReceipt !== undefined && !isDiscardReceipt(value.discardReceipt, value.taskId, value.workspaceId)) {
    throw new SdkProtocolError(`Task response carried a malformed row: ${JSON.stringify(value)}`)
  }
  return value as unknown as TaskSnapshot
}

/** Validate a bounded Task review summary without trusting provider output. */
function decodeTaskReviewSummary(value: unknown): TaskReviewSummary {
  if (!isRecord(value)
    || typeof value.taskId !== 'string'
    || typeof value.workspaceId !== 'string'
    || !isRevision(value.revision)
    || !isObjectId(value.baseCommit)
    || !isObjectId(value.headCommit)
    || !isObjectId(value.sourceHead)
    || typeof value.sourceDirty !== 'boolean'
    || typeof value.branch !== 'string' || value.branch.length === 0
    || typeof value.dirty !== 'boolean'
    || typeof value.truncated !== 'boolean'
    || !Array.isArray(value.files) || !value.files.every(isReviewFile)
    || !isCount(value.additions) || !isCount(value.deletions)) {
    throw new SdkProtocolError(`task/reviewSummary returned a malformed snapshot: ${JSON.stringify(value)}`)
  }
  return value as unknown as TaskReviewSummary
}

/** Validate one bounded file diff without interpreting patch text. */
function decodeTaskFileDiff(value: unknown): TaskFileDiff {
  if (!isRecord(value)
    || typeof value.taskId !== 'string'
    || typeof value.workspaceId !== 'string'
    || !isRevision(value.revision)
    || !isReviewPath(value.path)
    || value.previousPath !== undefined && !isReviewPath(value.previousPath)
    || typeof value.binary !== 'boolean'
    || typeof value.truncated !== 'boolean'
    || typeof value.patch !== 'string') {
    throw new SdkProtocolError(`task/reviewDiff returned a malformed diff: ${JSON.stringify(value)}`)
  }
  return value as unknown as TaskFileDiff
}

const REVIEW_FILE_STATUSES = new Set([
  'added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'untracked', 'conflicted',
])

/** Validate one review file row. */
function isReviewFile(value: unknown): boolean {
  return isRecord(value)
    && isReviewPath(value.path)
    && (value.previousPath === undefined || isReviewPath(value.previousPath))
    && REVIEW_FILE_STATUSES.has(String(value.status))
    && typeof value.binary === 'boolean'
    && (value.additions === null || isCount(value.additions))
    && (value.deletions === null || isCount(value.deletions))
}

function isCommitReceipt(value: unknown, taskId: string, workspaceId: unknown): boolean {
  return isRecord(value) && value.kind === 'commit' && isReceiptIdentity(value, taskId, workspaceId)
    && isRevision(value.reviewRevision) && isRevision(value.committedRevision)
    && typeof value.branch === 'string' && value.branch.length > 0
    && isObjectId(value.commit) && isTimestamp(value.committedAt)
}

function isApplyReceipt(value: unknown, taskId: string, workspaceId: unknown): boolean {
  return isRecord(value) && value.kind === 'apply' && isReceiptIdentity(value, taskId, workspaceId)
    && isRevision(value.reviewRevision) && isObjectId(value.commit)
    && isObjectId(value.sourceHeadBefore) && isObjectId(value.sourceHeadAfter)
    && isTimestamp(value.appliedAt)
}

function isDiscardReceipt(value: unknown, taskId: string, workspaceId: unknown): boolean {
  return isRecord(value) && value.kind === 'discard' && isReceiptIdentity(value, taskId, workspaceId)
    && isRevision(value.reviewRevision) && typeof value.branch === 'string' && value.branch.length > 0
    && typeof value.branchPreserved === 'boolean' && typeof value.worktreeRemoved === 'boolean'
    && typeof value.uncommittedChangesDiscarded === 'boolean'
    && (value.recoverableCommit === undefined || isObjectId(value.recoverableCommit))
    && isTimestamp(value.discardedAt)
}

function isReceiptIdentity(value: Record<string, unknown>, taskId: string, workspaceId: unknown): boolean {
  return isUuid(value.operationId) && value.taskId === taskId
    && typeof workspaceId === 'string' && value.workspaceId === workspaceId
}

function isReviewPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\\') && !value.startsWith('/')
    && !value.includes('\0') && !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
}

function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value)
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

/** Validate an application-owned worktree assignment without rewriting its paths. */
function isTaskWorktreeAssignment(
  value: unknown,
  taskId: string,
  workspaceId: unknown,
): value is NonNullable<TaskSnapshot['executionWorkspace']> {
  return isRecord(value)
    && value.kind === 'git-worktree'
    && value.taskId === taskId
    && typeof workspaceId === 'string'
    && value.workspaceId === workspaceId
    && typeof value.sourcePath === 'string' && value.sourcePath.length > 0
    && typeof value.path === 'string' && value.path.length > 0
    && typeof value.branch === 'string' && /^dsh\/task-[0-9a-f]{24}$/u.test(value.branch)
    && typeof value.baseCommit === 'string' && /^[0-9a-f]{40}$/u.test(value.baseCommit)
    && value.sourceHead === value.baseCommit
    && typeof value.sourceDirty === 'boolean'
    && typeof value.sourceStatusDigest === 'string' && /^[0-9a-f]{64}$/u.test(value.sourceStatusDigest)
    && Number.isSafeInteger(value.createdAt) && Number(value.createdAt) >= 0
}

/** The message of a thrown value (the transport only throws `Error`s; `String` covers the rest). */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- the transport and dispose ladder reject only with Errors */
  return error instanceof Error ? error.message : String(error)
}
