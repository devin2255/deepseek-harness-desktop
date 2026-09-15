/**
 * Named wire types for the DeepSeek Harness SDK runtime protocol: the three
 * request/result pairs and the four server-to-client notification payloads
 * exchanged over the newline-delimited JSON-RPC stdio transport. The server
 * plugin (`@deepseek-ai/dsh-sdk-jsonrpc-server`) and SDK clients share these shapes;
 * `serverInfo.name` stays the wire-stable `deepseek-harness-sdk-runtime`.
 *
 * @module @deepseek-ai/dsh-sdk-protocol/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type {
  DefineTaskRequest, RecordTaskRiskRequest, ReviewTaskRequest, TaskListSnapshot,
  TaskSnapshot, UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task/types'
import type { TaskFileDiff, TaskReviewRevision, TaskReviewSummary } from '@deepseek-ai/dsh-task-review/types'

/** Parameters for loading one assigned Task's bounded review summary. */
export interface TaskReviewSummaryParams {
  readonly sessionId: string
}

/** Parameters for loading one file from an exact Task review revision. */
export interface TaskReviewDiffParams {
  readonly sessionId: string
  readonly path: string
  readonly expectedRevision: TaskReviewRevision
}

/** Parameters for committing one exact ready Task review. */
export interface TaskCommitParams {
  readonly sessionId: string
  readonly expectedRevision: TaskReviewRevision
  readonly message: string
  readonly expectedSeq: number
}

/** Parameters for applying one exact Task commit to its source checkout. */
export interface TaskApplyParams {
  readonly sessionId: string
  readonly expectedRevision: TaskReviewRevision
  readonly expectedSourceHead: string
  readonly commit: string
  readonly expectedSeq: number
}

/** Parameters for removing one exact Task worktree. */
export interface TaskDiscardParams {
  readonly sessionId: string
  readonly expectedRevision: TaskReviewRevision
  readonly confirmedUncommittedLoss: boolean
  readonly expectedSeq: number
}

/** Parameters for the process-wide SDK handshake. */
export interface InitializeParams {
  /** Working directory recorded on every SDK-created session's header. */
  cwd: string
  /** Provider route every SDK-created agent runs on. */
  provider: string
  /** Model name every SDK-created agent runs on (the server may mount a fallback adapter; see `HarnessSdkJsonRpcServer.initialize`). */
  model: string
  /** Optional positive output-token cap inherited by SDK-created agents and their in-process descendants. */
  maxTokens?: number
}

/** Wire-stable server identity returned by initialization. */
export interface InitializeResult {
  /** Wire-stable server identity (`deepseek-harness-sdk-runtime`) and version. */
  serverInfo: { name: string; version: string }
}

/** One user turn on one SDK session. */
export interface SessionPromptParams {
  /** The SDK-side session id; an unknown id lazily creates the agent+session pair. */
  sessionId: string
  /** The prompt content blocks, sent verbatim as the user message. */
  contentBlocks: ContentBlock[]
}

/** Durable enqueue receipt for one prompt. */
export interface SessionPromptResult {
  /** Identity of the queued user message. */
  messageId: string
}

/** Deployment-mapped SDK outcome: `ok` for an accepted result, `error` otherwise. */
export type SdkRunStatus = 'ok' | 'error'

/** `session.event` payload: one session-log event, streamed as it is recorded. */
export interface SessionEventNotification {
  /** Session the event belongs to (every session in the runtime, not only SDK-created ones). */
  sessionId: string
  /** The full session-log event envelope. */
  event: SessionEvent
}

/** Whole-agent lifecycle state for one session. */
export interface SessionStatusNotification {
  /** Session whose live agent changed status. */
  sessionId: string
  /** The whole-agent state after the transition. */
  status: 'idle' | 'running'
}

/** `subagent.started` payload: an in-runtime child session was created. */
export interface SubagentStartedNotification {
  /** The delegating session. */
  parentSessionId: string
  /** The new child session. */
  childSessionId: string
}

/** `subagent.finished` payload: an in-process subagent run ended (remote runs are not reported). */
export interface SubagentFinishedNotification {
  /** Subagent provider name that ran the child. */
  provider: string
  /** The child agent's id (equals {@link childSessionId} for local runs). */
  agentId: string
  /** The delegating session. */
  parentSessionId: string
  /** The child session. */
  childSessionId: string
  /** Deployment-mapped run outcome. */
  status: SdkRunStatus
  /** The provider-reported stop reason. */
  stopReason: SubagentStopReason
  /** The child's selected assistant output; absent when the child produced none. */
  lastAssistantMessage?: ContentBlock[]
}

/** Server-to-client notifications by JSON-RPC method name. */
export interface HarnessSdkNotificationMap {
  'session.event': SessionEventNotification
  'session.status': SessionStatusNotification
  'subagent.started': SubagentStartedNotification
  'subagent.finished': SubagentFinishedNotification
}

/** Client-to-server request methods with their param and result shapes. */
export interface HarnessSdkRequestMap {
  'initialize': { params: InitializeParams; result: InitializeResult }
  'session/prompt': { params: SessionPromptParams; result: SessionPromptResult }
  'task/list': { params: Record<string, never>; result: TaskListSnapshot }
  'task/define': { params: DefineTaskRequest & { sessionId: string }; result: TaskSnapshot }
  'task/updateCriterion': { params: UpdateTaskCriterionRequest & { sessionId: string }; result: TaskSnapshot }
  'task/recordRisk': { params: RecordTaskRiskRequest & { sessionId: string }; result: TaskSnapshot }
  'task/review': { params: ReviewTaskRequest & { sessionId: string }; result: TaskSnapshot }
  'task/reviewSummary': { params: TaskReviewSummaryParams; result: TaskReviewSummary }
  'task/reviewDiff': { params: TaskReviewDiffParams; result: TaskFileDiff }
  'task/commit': { params: TaskCommitParams; result: TaskSnapshot }
  'task/apply': { params: TaskApplyParams; result: TaskSnapshot }
  'task/discard': { params: TaskDiscardParams; result: TaskSnapshot }
  'shutdown': { params: undefined; result: Record<string, never> }
}
