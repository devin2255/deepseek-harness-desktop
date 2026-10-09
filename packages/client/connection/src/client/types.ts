/** Browser-safe wire types shared by the connection API and public client entrypoint. */
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry, AgentPresetCompositionView,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  GoalsApi, GoalRef,
  AttentionItem, DefineTaskCriterion, TaskCriterion, TaskDefinition, TaskEvidenceRef,
  TaskListChange, TaskListSnapshot, TaskReviewDecision, TaskRisk, TaskSnapshot, TasksApi,
  TaskApplyReceipt, TaskCommitReceipt, TaskDeliveryInspection, TaskDiscardReceipt, TaskFileDiff,
  TaskReviewFile, TaskReviewOperationId, TaskReviewSummary,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
} from '@deepseek-ai/dsh-host-apiproxy/api'
export type { ToolCallView, ToolResultView } from '@deepseek-ai/dsh-tools/presentation'
export type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
export type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session/types'
export type { MessageId } from '@deepseek-ai/dsh-llm/brand'
export type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'

/** Successful value returned by the connection-generation host handshake. */
export type HostDescription = import('@deepseek-ai/dsh-host-apiproxy/api').ResponseValue<'host.describe'>
