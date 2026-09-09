/** Strict wire schemas for task baselines, changes, and mutations. */

import { z } from 'zod'
import type { TaskListChange, TaskListSnapshot, TaskSnapshot } from '@deepseek-ai/dsh-task/types'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'

const nonBlank = z.string().min(1).refine(value => value === value.trim(), 'must not have surrounding whitespace')
const identity = nonBlank
const sequence = z.number().int().nonnegative()

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

/** Complete immutable assignment of one application-owned Git worktree. */
export const taskWorktreeAssignmentSchema = z.strictObject({
  kind: z.literal('git-worktree'),
  taskId: identity,
  workspaceId: identity,
  sourcePath: nonBlank,
  path: nonBlank,
  branch: z.string().regex(/^dsh\/task-[0-9a-f]{24}$/),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  sourceHead: z.string().regex(/^[0-9a-f]{40}$/),
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
  reviewDecision: z.enum(['changes-requested', 'ready', 'committed', 'applied', 'archived', 'discarded']).optional(),
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
export const taskReviewRequestSchema = z.strictObject({ sessionId: identity, decision: z.enum(['changes-requested', 'ready', 'committed', 'applied', 'archived', 'discarded']), expectedSeq: sequence }) as unknown as z.ZodType<Wire<RequestPayload<'task.review'>>>
/** task.review response value. */
export const taskReviewValueSchema: z.ZodType<Wire<ResponseValue<'task.review'>>> = taskSnapshotSchema
