/** Strict wire schemas for task baselines, changes, and mutations. */

import { z } from 'zod'
import type { TaskListChange, TaskListSnapshot, TaskSnapshot } from '@deepseek-ai/dsh-task/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

const nonBlank = z.string().min(1).refine(value => value === value.trim(), 'must not have surrounding whitespace')
const identity = nonBlank
const sequence = z.number().int().nonnegative()
const gitObjectId = z.string().regex(/^[0-9a-f]{40}$/)
const reviewRevision = z.string().regex(/^[0-9a-f]{64}$/)
const operationId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const reviewPath = z.string().min(1).refine(value =>
  !value.includes('\\') && !value.includes('\0') && !/^(?:[A-Za-z]:|\/)/.test(value)
  && value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..'),
'must be a normalized repository-relative path')

const evidenceSchema = z.strictObject({ sessionId: identity, seq: sequence })
const criterionSchema = z.strictObject({
  id: identity,
  text: nonBlank,
  status: z.enum(['pending', 'satisfied', 'failed', 'waived']),
  evidence: z.array(evidenceSchema),
})
const riskSchema = z.strictObject({
  id: identity,
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  summary: nonBlank,
  resolution: nonBlank.optional(),
})
const definitionSchema = z.strictObject({
  goal: nonBlank,
  criteria: z.array(criterionSchema),
}).refine(value => new Set(value.criteria.map(criterion => criterion.id)).size === value.criteria.length, 'criterion ids must be unique')
const attentionSchema = z.strictObject({
  id: identity,
  taskId: identity,
  ownerSessionId: identity,
  kind: z.enum(['approval', 'question', 'plan-review', 'run-failure', 'merge-conflict', 'validation-failure', 'review-request']),
  severity: z.enum(['info', 'warning', 'error', 'critical']),
  summary: nonBlank,
  createdAt: z.number().int(),
  sourceId: identity,
  actionable: z.boolean(),
})
const taskReviewFileSchema = z.strictObject({
  path: reviewPath,
  previousPath: reviewPath.optional(),
  status: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type-changed', 'untracked', 'conflicted']),
  binary: z.boolean(),
  additions: sequence.nullable(),
  deletions: sequence.nullable(),
})
const taskCommitReceiptSchema = z.strictObject({
  kind: z.literal('commit'), operationId, taskId: identity, workspaceId: identity,
  reviewRevision, committedRevision: reviewRevision, branch: nonBlank, commit: gitObjectId,
  committedAt: sequence,
})
const taskApplyReceiptSchema = z.strictObject({
  kind: z.literal('apply'), operationId, taskId: identity, workspaceId: identity,
  reviewRevision, commit: gitObjectId, sourceHeadBefore: gitObjectId, sourceHeadAfter: gitObjectId,
  appliedAt: sequence,
}).refine(value => value.sourceHeadBefore === value.sourceHeadAfter, 'source application must not change HEAD')
const taskDiscardReceiptSchema = z.strictObject({
  kind: z.literal('discard'), operationId, taskId: identity, workspaceId: identity,
  reviewRevision, branch: nonBlank, branchPreserved: z.literal(true), worktreeRemoved: z.literal(true),
  uncommittedChangesDiscarded: z.boolean(), recoverableCommit: gitObjectId.optional(), discardedAt: sequence,
})

/** Complete immutable assignment of one application-owned Git worktree. */
export const taskWorktreeAssignmentSchema = z.strictObject({
  kind: z.literal('git-worktree'),
  taskId: identity,
  workspaceId: identity,
  sourcePath: nonBlank,
  path: nonBlank,
  branch: z.string().regex(/^dsh\/task-[0-9a-f]{24}$/),
  baseCommit: gitObjectId,
  sourceHead: gitObjectId,
  sourceDirty: z.boolean(),
  sourceStatusDigest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.number().int().nonnegative(),
}).refine(value => value.baseCommit === value.sourceHead, 'baseCommit must equal sourceHead')

/** Detached whole-row task projection. */
export const taskSnapshotSchema = z.strictObject({
  taskId: identity,
  workspaceId: identity.optional(),
  executionWorkspace: taskWorktreeAssignmentSchema.optional(),
  definition: definitionSchema.optional(),
  descendantSessionIds: z.array(identity),
  status: z.enum(['needs-attention', 'failed', 'running', 'reviewing', 'ready', 'settled']),
  freshness: z.enum(['live', 'disconnected', 'unavailable']),
  attention: z.array(attentionSchema),
  risks: z.array(riskSchema),
  reviewDecision: z.enum(['changes-requested', 'ready']).optional(),
  commitReceipt: taskCommitReceiptSchema.optional(),
  applyReceipt: taskApplyReceiptSchema.optional(),
  discardReceipt: taskDiscardReceiptSchema.optional(),
  updatedAt: z.number().int(),
  asOfSeq: sequence,
}).refine(
  value => value.executionWorkspace === undefined
    || value.executionWorkspace.taskId === value.taskId
      && value.executionWorkspace.workspaceId === value.workspaceId,
  'executionWorkspace must match the Task and Workspace identities',
) as unknown as z.ZodType<Wire<TaskSnapshot>>

/** Complete task-list baseline. */
export const taskListSnapshotSchema = z.strictObject({
  generation: sequence,
  tasks: z.array(taskSnapshotSchema),
}) as unknown as z.ZodType<Wire<TaskListSnapshot>>

/** Generation-scoped task-list change. */
export const taskListChangeSchema = z.strictObject({
  generation: sequence,
  upserts: z.array(taskSnapshotSchema),
  removed: z.array(identity),
}) as unknown as z.ZodType<Wire<TaskListChange>>

const defineCriterionSchema = z.strictObject({ id: identity.optional(), text: nonBlank })

/** task.list request payload. */
export const taskListRequestSchema = z.strictObject({}) as unknown as z.ZodType<Wire<RequestPayload<'task.list'>>>
/** task.list response value. */
export const taskListValueSchema: z.ZodType<Wire<ResponseValue<'task.list'>>> = taskListSnapshotSchema
/** task.define request payload. */
export const taskDefineRequestSchema = z.strictObject({
  sessionId: identity,
  goal: nonBlank,
  criteria: z.array(defineCriterionSchema),
  expectedSeq: sequence,
}).refine((value) => {
  const ids = value.criteria.flatMap(criterion => criterion.id === undefined ? [] : [criterion.id])
  return new Set(ids).size === ids.length
}, 'criterion ids must be unique') as unknown as z.ZodType<Wire<RequestPayload<'task.define'>>>
/** task.define response value. */
export const taskDefineValueSchema: z.ZodType<Wire<ResponseValue<'task.define'>>> = taskSnapshotSchema
/** task.updateCriterion request payload. */
export const taskUpdateCriterionRequestSchema = z.strictObject({ sessionId: identity, criterion: criterionSchema, expectedSeq: sequence }) as unknown as z.ZodType<Wire<RequestPayload<'task.updateCriterion'>>>
/** task.updateCriterion response value. */
export const taskUpdateCriterionValueSchema: z.ZodType<Wire<ResponseValue<'task.updateCriterion'>>> = taskSnapshotSchema
/** task.recordRisk request payload. */
export const taskRecordRiskRequestSchema = z.strictObject({ sessionId: identity, risk: riskSchema, expectedSeq: sequence }) as unknown as z.ZodType<Wire<RequestPayload<'task.recordRisk'>>>
/** task.recordRisk response value. */
export const taskRecordRiskValueSchema: z.ZodType<Wire<ResponseValue<'task.recordRisk'>>> = taskSnapshotSchema
/** task.review request payload. */
export const taskReviewRequestSchema = z.strictObject({ sessionId: identity, decision: z.enum(['changes-requested', 'ready']), expectedSeq: sequence }) as unknown as z.ZodType<Wire<RequestPayload<'task.review'>>>
/** task.review response value. */
export const taskReviewValueSchema: z.ZodType<Wire<ResponseValue<'task.review'>>> = taskSnapshotSchema
/** task.reviewSummary request payload. */
export const taskReviewSummaryRequestSchema = z.strictObject({ sessionId: identity }) as unknown as z.ZodType<Wire<RequestPayload<'task.reviewSummary'>>>
/** task.reviewSummary response value. */
export const taskReviewSummaryValueSchema = z.strictObject({
  taskId: identity, workspaceId: identity, revision: reviewRevision, baseCommit: gitObjectId,
  headCommit: gitObjectId, sourceHead: gitObjectId, sourceDirty: z.boolean(), branch: nonBlank,
  dirty: z.boolean(), truncated: z.boolean(), files: z.array(taskReviewFileSchema), additions: sequence, deletions: sequence,
}) as unknown as z.ZodType<Wire<ResponseValue<'task.reviewSummary'>>>
/** task.reviewDiff request payload. */
export const taskReviewDiffRequestSchema = z.strictObject({
  sessionId: identity, path: reviewPath, expectedRevision: reviewRevision,
}) as unknown as z.ZodType<Wire<RequestPayload<'task.reviewDiff'>>>
/** task.reviewDiff response value. */
export const taskReviewDiffValueSchema = z.strictObject({
  taskId: identity, workspaceId: identity, revision: reviewRevision, path: reviewPath,
  previousPath: reviewPath.optional(), binary: z.boolean(), truncated: z.boolean(), patch: z.string(),
}) as unknown as z.ZodType<Wire<ResponseValue<'task.reviewDiff'>>>
/** task.commit request payload. */
export const taskCommitRequestSchema = z.strictObject({
  sessionId: identity, expectedRevision: reviewRevision, message: nonBlank, expectedSeq: sequence,
}) as unknown as z.ZodType<Wire<RequestPayload<'task.commit'>>>
/** task.commit response value. */
export const taskCommitValueSchema: z.ZodType<Wire<ResponseValue<'task.commit'>>> = taskSnapshotSchema
/** task.apply request payload. */
export const taskApplyRequestSchema = z.strictObject({
  sessionId: identity, expectedRevision: reviewRevision, expectedSourceHead: gitObjectId,
  commit: gitObjectId, expectedSeq: sequence,
}) as unknown as z.ZodType<Wire<RequestPayload<'task.apply'>>>
/** task.apply response value. */
export const taskApplyValueSchema: z.ZodType<Wire<ResponseValue<'task.apply'>>> = taskSnapshotSchema
/** task.discard request payload. */
export const taskDiscardRequestSchema = z.strictObject({
  sessionId: identity, expectedRevision: reviewRevision, confirmedUncommittedLoss: z.boolean(), expectedSeq: sequence,
}) as unknown as z.ZodType<Wire<RequestPayload<'task.discard'>>>
/** task.discard response value. */
export const taskDiscardValueSchema: z.ZodType<Wire<ResponseValue<'task.discard'>>> = taskSnapshotSchema
