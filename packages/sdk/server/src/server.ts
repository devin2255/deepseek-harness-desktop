/**
 * JSON-RPC methods and notifications for out-of-process harness SDKs.
 * The surrounding context owns plugins, persistence, and configured adapters.
 *
 * @module @deepseek-ai/dsh-sdk-jsonrpc-server/server
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolve } from 'node:path'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { carrierKeyOf, type Scoped } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-task'
import type {
  DefineTaskRequest, RecordTaskRiskRequest, ReviewTaskRequest, TaskListSnapshot,
  TaskSnapshot, UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task/types'
import type {} from '@deepseek-ai/dsh-task-review'
import { TaskReviewRevision, type TaskFileDiff, type TaskReviewSummary } from '@deepseek-ai/dsh-task-review/types'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type {
  InitializeParams,
  InitializeResult,
  JsonRpcTransportPeer,
  SessionEventNotification,
  SessionPromptParams,
  SessionPromptResult,
  SubagentFinishedNotification,
  SubagentStartedNotification,
  TaskApplyParams,
  TaskCommitParams,
  TaskDiscardParams,
  TaskReviewDiffParams,
} from '@deepseek-ai/dsh-sdk-protocol'

interface SessionRecord {
  handle: AgentHandle
}

/** Recover the delegating parent from the service-owned scoped carrier. */
function subagentParentOf(carrier: Scoped<SubagentRuntime>): Agent {
  return carrierKeyOf(carrier) as Agent
}

/** Deployment-specific status mapping for SDK turn and subagent outcomes. */
export interface HarnessSdkJsonRpcServerOptions {
  /** Report max-token termination as an accepted result instead of an infrastructure error. */
  maxTokensAsSuccess?: boolean
}

function successStatus(reason: string, options: HarnessSdkJsonRpcServerOptions): 'ok' | 'error' {
  if (reason === 'completed') return 'ok'
  return reason === 'max-tokens' && options.maxTokensAsSuccess === true ? 'ok' : 'error'
}

/**
 * SDK server over one booted harness context and transport peer. Construction
 * subscribes to session, agent, and subagent lifecycle events until shutdown;
 * reinitialization is unsupported.
 */
export class HarnessSdkJsonRpcServer {
  private cwd = process.cwd()
  private provider = 'deepseek-official'
  private model = 'deepseek-official'
  private maxTokens: number | undefined
  private llmFiber: { dispose(): Promise<void> } | undefined
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionCreations = new Map<string, Promise<SessionRecord>>()
  private readonly disposers: (() => void)[] = []
  private shutdownTask: Promise<Record<string, never>> | undefined
  private shuttingDown = false

  constructor(
    private readonly ctx: Context,
    private readonly transport: JsonRpcTransportPeer,
    private readonly options: HarnessSdkJsonRpcServerOptions = {},
  ) {
    const serverOptions = this.options
    this.disposers.push(ctx.on('session/event', (session, event) => {
      const payload: SessionEventNotification = { sessionId: String(session.id), event }
      this.transport.notify('session.event', payload)
    }))
    this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
      this.transport.notify('session.status', { sessionId: String(agent.session.id), status })
    }))
    this.disposers.push(ctx.on('session/created', (session) => {
      const parentSession = session.header.parentSession
      if (parentSession === undefined) return
      const payload: SubagentStartedNotification = {
        parentSessionId: String(parentSession),
        childSessionId: String(session.id),
      }
      this.transport.notify('subagent.started', payload)
    }))
    this.disposers.push(ctx.on('subagent/end', function (this: Scoped<SubagentRuntime>, info: SubagentRunEndInfo) {
      const parent = subagentParentOf(this)
      // This protocol reports only in-process child sessions. The service
      // snapshots the provider name and local flag through child disposal;
      // matching ids or parent lineage alone never establishes locality.
      if (!info.local) return
      const payload: SubagentFinishedNotification = {
        provider: info.provider,
        agentId: String(info.id),
        parentSessionId: String(parent.session.id),
        childSessionId: String(info.id),
        status: successStatus(info.stopReason, serverOptions),
        stopReason: info.stopReason,
        ...(info.lastAssistantMessage === undefined ? {} : { lastAssistantMessage: info.lastAssistantMessage }),
      }
      transport.notify('subagent.finished', payload)
    }))
  }

  /**
   * Configure the SDK route, mounting the DeepSeek fallback only when unowned.
   * @param params - SDK handshake parameters.
   * @returns server identity for the handshake.
   */
  async initialize(params: InitializeParams): Promise<InitializeResult> {
    if (params.maxTokens !== undefined
      && (!Number.isSafeInteger(params.maxTokens) || params.maxTokens <= 0)) {
      throw new TypeError('initialize maxTokens must be a positive safe integer')
    }
    this.cwd = resolve(params.cwd)
    this.provider = params.provider
    this.model = params.model
    this.maxTokens = params.maxTokens
    if (!this.hasAdapterFor(this.provider)) {
      if (this.provider !== 'deepseek-official') throw new Error(`no adapter registered for provider "${this.provider}"`)
      this.llmFiber = await this.ctx.plugin(LlmDeepSeek, {})
    }
    return { serverInfo: { name: 'deepseek-harness-sdk-runtime', version: '0.0.1' } }
  }

  /**
   * Queue one identified prompt without assigning later activity to it.
   * @param params - target session and user content.
   * @returns the durable message identity.
   */
  async prompt(params: SessionPromptParams): Promise<SessionPromptResult> {
    const rec = await this.getOrCreateSession(params.sessionId)
    // An agent-loop-only reload disposes the loop's agents while this record
    // survives; a retained agent accepts followup() silently, so validate the
    // record against the live registry before delivery (as the ACP bridge does).
    if (this.ctx.agents.get(rec.handle.agent.id) !== rec.handle.agent) {
      throw new Error(`session agent was disposed outside the server: ${params.sessionId}`)
    }
    const message = createUserMessage({ content: params.contentBlocks, source: { kind: 'user' } })
    rec.handle.agent.followup(message)
    return { messageId: message.id }
  }

  /**
   * Read the current Task baseline.
   * @returns the detached baseline.
   */
  listTasks(): TaskListSnapshot {
    const tasks = this.ctx.get('tasks')
    if (tasks === undefined) throw new Error('Task service is unavailable in this SDK runtime')
    return tasks.snapshot()
  }

  /**
   * Define a root Task.
   * @param sessionId - root Session.
   * @param request - definition command.
   * @returns committed Task.
   */
  defineTask(sessionId: string, request: DefineTaskRequest): Promise<TaskSnapshot> {
    const tasks = this.ctx.get('tasks')
    if (tasks === undefined) throw new Error('Task service is unavailable in this SDK runtime')
    return tasks.define(SessionId(sessionId), request)
  }

  /**
   * Update one criterion.
   * @param sessionId - root Session.
   * @param request - criterion command.
   * @returns committed Task.
   */
  updateTaskCriterion(sessionId: string, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot> {
    const tasks = this.ctx.get('tasks')
    if (tasks === undefined) throw new Error('Task service is unavailable in this SDK runtime')
    return tasks.updateCriterion(SessionId(sessionId), request)
  }

  /**
   * Record one risk.
   * @param sessionId - root Session.
   * @param request - risk command.
   * @returns committed Task.
   */
  recordTaskRisk(sessionId: string, request: RecordTaskRiskRequest): Promise<TaskSnapshot> {
    const tasks = this.ctx.get('tasks')
    if (tasks === undefined) throw new Error('Task service is unavailable in this SDK runtime')
    return tasks.recordRisk(SessionId(sessionId), request)
  }

  /**
   * Review one Task.
   * @param sessionId - root Session.
   * @param request - review command.
   * @returns committed Task.
   */
  reviewTask(sessionId: string, request: ReviewTaskRequest): Promise<TaskSnapshot> {
    const tasks = this.ctx.get('tasks')
    if (tasks === undefined) throw new Error('Task service is unavailable in this SDK runtime')
    return tasks.review(SessionId(sessionId), request)
  }

  /**
   * Load one assigned Task's bounded review summary.
   * @param sessionId - root Session.
   * @returns the provider-owned review summary.
   */
  async getTaskReviewSummary(sessionId: string): Promise<TaskReviewSummary> {
    const target = this.taskReviewTarget(sessionId)
    return target.review.summarize({ assignment: target.task.executionWorkspace })
  }

  /**
   * Load one file from an exact Task review snapshot.
   * @param params - root Session, exact revision, and repository-relative path.
   * @returns the provider-owned bounded file diff.
   */
  async getTaskReviewDiff(params: TaskReviewDiffParams): Promise<TaskFileDiff> {
    const target = this.taskReviewTarget(params.sessionId)
    return target.review.diff({
      assignment: target.task.executionWorkspace,
      path: params.path,
      expectedRevision: TaskReviewRevision(params.expectedRevision),
    })
  }

  /**
   * Commit one exact ready Task review and record its receipt.
   * @param params - root Session, revision, message, and compare-and-set sequence.
   * @returns the Task carrying its durable commit receipt.
   */
  async commitTask(params: TaskCommitParams): Promise<TaskSnapshot> {
    const target = this.taskReviewTarget(params.sessionId)
    this.assertTaskSequence(target.task, params.expectedSeq)
    if (target.task.status !== 'ready' || target.task.commitReceipt !== undefined
      || target.task.discardReceipt !== undefined) {
      throw new Error('Commit requires a ready Task without an existing delivery receipt.')
    }
    const receipt = await target.review.commit({
      assignment: target.task.executionWorkspace,
      expectedRevision: TaskReviewRevision(params.expectedRevision),
      message: params.message,
    })
    return target.tasks.recordCommit(SessionId(params.sessionId), { receipt, expectedSeq: params.expectedSeq })
  }

  /**
   * Apply one exact recorded Task commit and record its receipt.
   * @param params - root Session, committed revision, source head, commit, and sequence.
   * @returns the Task carrying its durable apply receipt.
   */
  async applyTask(params: TaskApplyParams): Promise<TaskSnapshot> {
    const target = this.taskReviewTarget(params.sessionId)
    this.assertTaskSequence(target.task, params.expectedSeq)
    const committed = target.task.commitReceipt
    if (committed === undefined || target.task.applyReceipt !== undefined || target.task.discardReceipt !== undefined
      || committed.commit !== params.commit || committed.committedRevision !== params.expectedRevision) {
      throw new Error('Apply requires the exact recorded Task commit without an existing apply or discard receipt.')
    }
    const receipt = await target.review.apply({
      assignment: target.task.executionWorkspace,
      expectedRevision: TaskReviewRevision(params.expectedRevision),
      expectedSourceHead: params.expectedSourceHead,
      commit: params.commit,
    })
    return target.tasks.recordApply(SessionId(params.sessionId), { receipt, expectedSeq: params.expectedSeq })
  }

  /**
   * Explicitly release one Task worktree and record its receipt.
   * @param params - root Session, exact revision, loss confirmation, and sequence.
   * @returns the Task carrying its durable discard receipt.
   */
  async discardTask(params: TaskDiscardParams): Promise<TaskSnapshot> {
    const target = this.taskReviewTarget(params.sessionId)
    this.assertTaskSequence(target.task, params.expectedSeq)
    if (target.task.discardReceipt !== undefined
      || (target.task.status !== 'ready' && target.task.commitReceipt === undefined && target.task.applyReceipt === undefined)) {
      throw new Error('Discard requires a ready or delivered Task whose worktree has not already been removed.')
    }
    const receipt = await target.review.discard({
      assignment: target.task.executionWorkspace,
      expectedRevision: TaskReviewRevision(params.expectedRevision),
      confirmedUncommittedLoss: params.confirmedUncommittedLoss,
    })
    return target.tasks.recordDiscard(SessionId(params.sessionId), { receipt, expectedSeq: params.expectedSeq })
  }

  /**
   * Dispose server-owned agents, adapter, and subscriptions to quiescence.
   * The surrounding context remains running.
   * @returns empty JSON-RPC result.
   */
  shutdown(): Promise<Record<string, never>> {
    this.shutdownTask ??= this.performShutdown()
    return this.shutdownTask
  }

  private async performShutdown(): Promise<Record<string, never>> {
    this.shuttingDown = true
    const pendingCreations = [...this.sessionCreations.values()]
    await Promise.allSettled(pendingCreations)
    this.sessionCreations.clear()
    const records = [...this.sessions.values()]
    this.sessions.clear()
    const failures: unknown[] = []
    while (this.disposers.length > 0) {
      try {
        this.disposers.pop()?.()
      } catch (error) {
        failures.push(error)
      }
    }
    const teardownResults = await Promise.allSettled([
      ...records.map(rec => Promise.resolve().then(() => rec.handle.dispose())),
      ...(this.llmFiber === undefined ? [] : [Promise.resolve().then(() => this.llmFiber?.dispose())]),
    ])
    this.llmFiber = undefined
    failures.push(...teardownResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map(result => result.reason as unknown))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'SDK server teardown failed')
    return {}
  }

  /**
   * Dispatch one incoming JSON-RPC request to its typed handler. Throws (→ a
   * JSON-RPC error response) on an unknown method.
   * @param method - the JSON-RPC method name.
   * @param params - the raw params object from the wire.
   * @returns the handler's result, to be serialized as the response.
   */
  async handleRequest(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.initialize(params as unknown as InitializeParams)
      case 'session/prompt':
        return this.prompt(params as unknown as SessionPromptParams)
      case 'task/list':
        return this.listTasks()
      case 'task/define': {
        const { sessionId, ...request } = params as unknown as DefineTaskRequest & { sessionId: string }
        return this.defineTask(sessionId, request)
      }
      case 'task/updateCriterion': {
        const { sessionId, ...request } = params as unknown as UpdateTaskCriterionRequest & { sessionId: string }
        return this.updateTaskCriterion(sessionId, request)
      }
      case 'task/recordRisk': {
        const { sessionId, ...request } = params as unknown as RecordTaskRiskRequest & { sessionId: string }
        return this.recordTaskRisk(sessionId, request)
      }
      case 'task/review': {
        const { sessionId, ...request } = params as unknown as ReviewTaskRequest & { sessionId: string }
        return this.reviewTask(sessionId, request)
      }
      case 'task/reviewSummary':
        return this.getTaskReviewSummary((params as unknown as { sessionId: string }).sessionId)
      case 'task/reviewDiff':
        return this.getTaskReviewDiff(params as unknown as TaskReviewDiffParams)
      case 'task/commit':
        return this.commitTask(params as unknown as TaskCommitParams)
      case 'task/apply':
        return this.applyTask(params as unknown as TaskApplyParams)
      case 'task/discard':
        return this.discardTask(params as unknown as TaskDiscardParams)
      case 'shutdown':
        return this.shutdown()
      default:
        throw new Error(`unknown DeepSeek Harness SDK runtime method: ${method}`)
    }
  }

  private async getOrCreateSession(sessionId: string): Promise<SessionRecord> {
    if (this.shuttingDown) throw new Error('SDK server is shutting down')
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const pending = this.sessionCreations.get(sessionId)
    if (pending) return pending
    const creation = this.createSession(sessionId)
    this.sessionCreations.set(sessionId, creation)
    void creation.then(
      () => { this.sessionCreations.delete(sessionId) },
      () => { this.sessionCreations.delete(sessionId) },
    )
    return creation
  }

  private taskReviewTarget(sessionId: string) {
    const tasks = this.ctx.get('tasks')
    if (tasks === undefined) throw new Error('Task service is unavailable in this SDK runtime')
    const task = tasks.snapshot().tasks.find(candidate => candidate.taskId === sessionId)
    if (task === undefined) throw new Error(`Task "${sessionId}" does not exist`)
    if (task.executionWorkspace === undefined) {
      throw new Error('This Task has no application-owned Git worktree to review.')
    }
    const review = this.ctx.get('taskReview')
    if (review === undefined) throw new Error('Task review is unavailable in this SDK runtime')
    return { task: task as TaskSnapshot & { executionWorkspace: NonNullable<TaskSnapshot['executionWorkspace']> }, tasks, review }
  }

  private assertTaskSequence(task: TaskSnapshot, expectedSeq: number): void {
    if (task.asOfSeq !== expectedSeq) {
      throw new Error(`Task "${task.taskId}" expected sequence ${expectedSeq}, current sequence is ${task.asOfSeq}`)
    }
  }

  private async createSession(sessionId: string): Promise<SessionRecord> {
    // No preset composition: this server's compositions keep the model-facing
    // rows in the host plane, so this agent reads them from the global layer. A
    // deployment that configures a roster has to join one here first
    // (@deepseek-ai/dsh-agent-presets README, "Composing a child agent").
    const handle = await this.ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd: this.cwd },
      agentOptions: {
        provider: this.provider,
        model: this.model,
        ...this.maxTokens === undefined ? {} : { maxTokens: this.maxTokens },
      },
    })
    const rec: SessionRecord = { handle }
    this.sessions.set(sessionId, rec)
    return rec
  }

  private hasAdapterFor(provider: string): boolean {
    return this.ctx.get('llm')?.listProviders().some(entry => entry.id === provider) ?? false
  }
}
