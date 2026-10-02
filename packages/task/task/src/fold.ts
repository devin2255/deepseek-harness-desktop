/** Strict replay fold for durable root-task facts. */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree/types'
import type { TaskApplyReceipt, TaskCommitReceipt, TaskDiscardReceipt } from '@deepseek-ai/dsh-task-review/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  TaskCriterionId,
  TaskRiskId,
  type TaskCriterion,
  type TaskCriterionStatus,
  type TaskDefinition,
  type TaskEvidenceRef,
  type TaskReviewDecision,
  type TaskRisk,
  type TaskRiskSeverity,
} from './types.ts'

const CRITERION_STATUSES: ReadonlySet<TaskCriterionStatus> = new Set(['pending', 'satisfied', 'failed', 'waived'])
const RISK_SEVERITIES: ReadonlySet<TaskRiskSeverity> = new Set(['low', 'medium', 'high', 'critical'])
const REVIEW_DECISIONS: ReadonlySet<TaskReviewDecision> = new Set([
  'changes-requested', 'ready',
])

/** Result of replaying durable task facts from one root Session. */
export interface TaskFoldState {
  readonly assignment: TaskWorktreeAssignment | undefined
  readonly definition: TaskDefinition | undefined
  readonly risks: readonly TaskRisk[]
  readonly reviewDecision: TaskReviewDecision | undefined
  readonly commitReceipt: TaskCommitReceipt | undefined
  readonly applyReceipt: TaskApplyReceipt | undefined
  readonly discardReceipt: TaskDiscardReceipt | undefined
  readonly updatedAt: number | undefined
}

/** Durable task-log failure attributed to the event that could not be replayed. */
export class TaskLogError extends Error {
  /** Sequence of the rejected Session event. */
  readonly seq: number

  /**
   * Construct one attributed replay failure.
   * @param seq - rejected Session event sequence.
   * @param message - strict decoder or transition failure.
   * @param options - optional native error cause.
   */
  constructor(seq: number, message: string, options?: ErrorOptions) {
    super(`task event ${seq}: ${message}`, options)
    this.name = 'TaskLogError'
    this.seq = seq
  }
}

/**
 * Build an empty task accumulator.
 * @returns a fresh task accumulator with no durable facts.
 */
export function emptyTaskFoldState(): TaskFoldState {
  return {
    assignment: undefined,
    definition: undefined,
    risks: [],
    reviewDecision: undefined,
    commitReceipt: undefined,
    applyReceipt: undefined,
    discardReceipt: undefined,
    updatedAt: undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactRecord(value: unknown, fields: readonly string[], subject: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) {
    throw new Error(`${subject} must have exactly ${[...fields].sort().join(',')} fields`)
  }
  return value
}

function normalizedString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${subject} must be non-empty and normalized`)
  }
  return value
}

function normalizedPath(value: unknown, subject: string): string {
  const path = normalizedString(value, subject)
  if (path.includes('\u0000')) throw new Error(`${subject} must not contain a null character`)
  return path
}

function gitObjectId(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${subject} must be a lowercase forty-character Git object id`)
  }
  return value
}

function sha256Digest(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${subject} must be a lowercase SHA-256 digest`)
  }
  return value
}

function operationId(value: unknown, subject: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${subject} must be a normalized UUID`)
  }
  return value
}

function timestamp(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${subject} must be a non-negative safe integer`)
  }
  return value
}

function decodeWorktreeAssignment(value: unknown): TaskWorktreeAssignment {
  const record = exactRecord(value, [
    'baseCommit', 'branch', 'createdAt', 'kind', 'path', 'sourceDirty', 'sourceHead',
    'sourcePath', 'sourceStatusDigest', 'taskId', 'workspaceId',
  ], 'worktree assignment')
  if (record['kind'] !== 'git-worktree') throw new Error('worktree kind must be git-worktree')
  const taskId = normalizedString(record['taskId'], 'worktree taskId') as SessionId
  const workspaceId = normalizedString(record['workspaceId'], 'worktree workspaceId') as WorkspaceId
  const sourcePath = normalizedPath(record['sourcePath'], 'worktree sourcePath')
  const path = normalizedPath(record['path'], 'worktree path')
  if (sourcePath === path) throw new Error('worktree path must differ from sourcePath')
  const branch = normalizedString(record['branch'], 'worktree branch')
  if (!/^dsh\/task-[0-9a-f]{24}$/.test(branch)) throw new Error('worktree branch is invalid')
  const baseCommit = gitObjectId(record['baseCommit'], 'worktree baseCommit')
  const sourceHead = gitObjectId(record['sourceHead'], 'worktree sourceHead')
  if (baseCommit !== sourceHead) throw new Error('worktree baseCommit must equal sourceHead')
  if (typeof record['sourceDirty'] !== 'boolean') throw new Error('worktree sourceDirty must be boolean')
  if (typeof record['sourceStatusDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['sourceStatusDigest'])) {
    throw new Error('worktree sourceStatusDigest must be a lowercase SHA-256 digest')
  }
  if (typeof record['createdAt'] !== 'number' || !Number.isSafeInteger(record['createdAt']) || record['createdAt'] < 0) {
    throw new Error('worktree createdAt must be a non-negative safe integer')
  }
  return {
    kind: 'git-worktree', taskId, workspaceId, sourcePath, path, branch, baseCommit, sourceHead,
    sourceDirty: record['sourceDirty'], sourceStatusDigest: record['sourceStatusDigest'], createdAt: record['createdAt'],
  }
}

function decodeEvidence(value: unknown): TaskEvidenceRef {
  const record = exactRecord(value, ['sessionId', 'seq'], 'evidence reference')
  const sessionId = normalizedString(record['sessionId'], 'evidence sessionId') as SessionId
  const seq = record['seq']
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
    throw new Error('evidence seq must be a non-negative safe integer')
  }
  return { sessionId, seq }
}

function decodeCriterion(value: unknown): TaskCriterion {
  const record = exactRecord(value, ['evidence', 'id', 'status', 'text'], 'criterion')
  const id = TaskCriterionId(normalizedString(record['id'], 'criterion id'))
  const text = normalizedString(record['text'], 'criterion text')
  if (typeof record['status'] !== 'string'
    || !CRITERION_STATUSES.has(record['status'] as TaskCriterionStatus)) {
    throw new Error('criterion status is invalid')
  }
  if (!Array.isArray(record['evidence'])) throw new Error('criterion evidence must be an array')
  const evidence = record['evidence'].map(decodeEvidence)
  if (new Set(evidence.map(ref => `${ref.sessionId}\u0000${ref.seq}`)).size !== evidence.length) {
    throw new Error('criterion evidence references must be unique')
  }
  const status = record['status'] as TaskCriterionStatus
  if (status === 'satisfied' && evidence.length === 0) {
    throw new Error('satisfied criterion requires evidence')
  }
  return { id, text, status, evidence }
}

function decodeDefinition(value: unknown): TaskDefinition {
  const record = exactRecord(value, ['criteria', 'goal'], 'task definition')
  const goal = normalizedString(record['goal'], 'goal')
  if (!Array.isArray(record['criteria']) || record['criteria'].length === 0) {
    throw new Error('criteria must contain at least one item')
  }
  const criteria = record['criteria'].map(decodeCriterion)
  if (new Set(criteria.map(criterion => criterion.id)).size !== criteria.length) {
    throw new Error('criterion ids must be unique')
  }
  if (criteria.some(criterion => criterion.status !== 'pending' || criterion.evidence.length !== 0)) {
    throw new Error('defined criteria must start pending without evidence')
  }
  return { goal, criteria }
}

function decodeRisk(value: unknown): TaskRisk {
  if (!isRecord(value)) throw new Error('risk must be a record')
  const fields = value['resolution'] === undefined
    ? ['id', 'severity', 'summary']
    : ['id', 'resolution', 'severity', 'summary']
  const record = exactRecord(value, fields, 'risk')
  const id = TaskRiskId(normalizedString(record['id'], 'risk id'))
  const summary = normalizedString(record['summary'], 'risk summary')
  if (typeof record['severity'] !== 'string'
    || !RISK_SEVERITIES.has(record['severity'] as TaskRiskSeverity)) {
    throw new Error('risk severity is invalid')
  }
  const severity = record['severity'] as TaskRiskSeverity
  return record['resolution'] === undefined
    ? { id, severity, summary }
    : { id, severity, summary, resolution: normalizedString(record['resolution'], 'risk resolution') }
}

function decodeDecision(value: unknown): TaskReviewDecision {
  if (typeof value !== 'string' || !REVIEW_DECISIONS.has(value as TaskReviewDecision)) {
    throw new Error('review decision is invalid')
  }
  return value as TaskReviewDecision
}

function assertReceiptOwner(
  state: TaskFoldState,
  receipt: { readonly taskId: SessionId; readonly workspaceId: WorkspaceId },
  subject: string,
): TaskWorktreeAssignment {
  if (state.assignment === undefined) throw new Error(`${subject} requires an assigned worktree`)
  if (receipt.taskId !== state.assignment.taskId) throw new Error(`${subject} receipt taskId does not match the worktree assignment`)
  if (receipt.workspaceId !== state.assignment.workspaceId) throw new Error(`${subject} receipt workspaceId does not match the worktree assignment`)
  return state.assignment
}

function decodeCommitReceipt(value: unknown): TaskCommitReceipt {
  const record = exactRecord(value, [
    'branch', 'commit', 'committedAt', 'committedRevision', 'kind', 'operationId',
    'reviewRevision', 'taskId', 'workspaceId',
  ], 'commit receipt')
  if (record['kind'] !== 'commit') throw new Error('commit receipt kind must be commit')
  return {
    kind: 'commit',
    operationId: operationId(record['operationId'], 'commit receipt operationId') as TaskCommitReceipt['operationId'],
    taskId: normalizedString(record['taskId'], 'commit receipt taskId') as SessionId,
    workspaceId: normalizedString(record['workspaceId'], 'commit receipt workspaceId') as WorkspaceId,
    reviewRevision: sha256Digest(record['reviewRevision'], 'commit receipt reviewRevision') as TaskCommitReceipt['reviewRevision'],
    committedRevision: sha256Digest(record['committedRevision'], 'commit receipt committedRevision') as TaskCommitReceipt['committedRevision'],
    branch: normalizedString(record['branch'], 'commit receipt branch'),
    commit: gitObjectId(record['commit'], 'commit receipt commit'),
    committedAt: timestamp(record['committedAt'], 'commit receipt committedAt'),
  }
}

function decodeApplyReceipt(value: unknown): TaskApplyReceipt {
  const record = exactRecord(value, [
    'appliedAt', 'commit', 'kind', 'operationId', 'reviewRevision', 'sourceHeadAfter',
    'sourceHeadBefore', 'taskId', 'workspaceId',
  ], 'apply receipt')
  if (record['kind'] !== 'apply') throw new Error('apply receipt kind must be apply')
  return {
    kind: 'apply',
    operationId: operationId(record['operationId'], 'apply receipt operationId') as TaskApplyReceipt['operationId'],
    taskId: normalizedString(record['taskId'], 'apply receipt taskId') as SessionId,
    workspaceId: normalizedString(record['workspaceId'], 'apply receipt workspaceId') as WorkspaceId,
    reviewRevision: sha256Digest(record['reviewRevision'], 'apply receipt reviewRevision') as TaskApplyReceipt['reviewRevision'],
    commit: gitObjectId(record['commit'], 'apply receipt commit'),
    sourceHeadBefore: gitObjectId(record['sourceHeadBefore'], 'apply receipt sourceHeadBefore'),
    sourceHeadAfter: gitObjectId(record['sourceHeadAfter'], 'apply receipt sourceHeadAfter'),
    appliedAt: timestamp(record['appliedAt'], 'apply receipt appliedAt'),
  }
}

function decodeDiscardReceipt(value: unknown): TaskDiscardReceipt {
  if (!isRecord(value)) throw new Error('discard receipt must be a record')
  const fields = value['recoverableCommit'] === undefined
    ? ['branch', 'branchPreserved', 'discardedAt', 'kind', 'operationId', 'reviewRevision', 'taskId', 'uncommittedChangesDiscarded', 'workspaceId', 'worktreeRemoved']
    : ['branch', 'branchPreserved', 'discardedAt', 'kind', 'operationId', 'recoverableCommit', 'reviewRevision', 'taskId', 'uncommittedChangesDiscarded', 'workspaceId', 'worktreeRemoved']
  const record = exactRecord(value, fields, 'discard receipt')
  if (record['kind'] !== 'discard') throw new Error('discard receipt kind must be discard')
  if (record['branchPreserved'] !== true) throw new Error('discard receipt must confirm branch preservation')
  if (record['worktreeRemoved'] !== true) throw new Error('discard receipt must confirm worktree removal')
  if (typeof record['uncommittedChangesDiscarded'] !== 'boolean') {
    throw new Error('discard receipt uncommittedChangesDiscarded must be boolean')
  }
  const receipt: TaskDiscardReceipt = {
    kind: 'discard',
    operationId: operationId(record['operationId'], 'discard receipt operationId') as TaskDiscardReceipt['operationId'],
    taskId: normalizedString(record['taskId'], 'discard receipt taskId') as SessionId,
    workspaceId: normalizedString(record['workspaceId'], 'discard receipt workspaceId') as WorkspaceId,
    reviewRevision: sha256Digest(record['reviewRevision'], 'discard receipt reviewRevision') as TaskDiscardReceipt['reviewRevision'],
    branch: normalizedString(record['branch'], 'discard receipt branch'),
    branchPreserved: true,
    worktreeRemoved: true,
    uncommittedChangesDiscarded: record['uncommittedChangesDiscarded'],
    discardedAt: timestamp(record['discardedAt'], 'discard receipt discardedAt'),
  }
  return record['recoverableCommit'] === undefined
    ? receipt
    : { ...receipt, recoverableCommit: gitObjectId(record['recoverableCommit'], 'discard receipt recoverableCommit') }
}

function validateCriterionTransition(current: TaskCriterionStatus, next: TaskCriterionStatus): void {
  const allowed: Readonly<Record<TaskCriterionStatus, ReadonlySet<TaskCriterionStatus>>> = {
    pending: new Set(['pending', 'satisfied', 'failed', 'waived']),
    failed: new Set(['pending', 'satisfied', 'failed', 'waived']),
    satisfied: new Set(['pending', 'satisfied']),
    waived: new Set(['pending', 'waived']),
  }
  if (!allowed[current].has(next)) throw new Error(`criterion transition ${current} -> ${next} is invalid`)
}

function validateReview(state: TaskFoldState, decision: TaskReviewDecision): void {
  if (state.commitReceipt !== undefined || state.applyReceipt !== undefined || state.discardReceipt !== undefined) {
    throw new Error('review decision cannot change after delivery')
  }
  if (decision === 'ready') {
    if (state.definition === undefined
      || state.definition.criteria.some(criterion => criterion.status !== 'satisfied' && criterion.status !== 'waived')) {
      throw new Error('ready requires every criterion to be satisfied or waived')
    }
    if (state.risks.some(risk => risk.resolution === undefined)) {
      throw new Error('ready requires every risk to be resolved')
    }
    return
  }
  if (state.definition === undefined) {
    throw new Error('changes-requested requires a current definition')
  }
}

/**
 * Strictly validate and apply one Session event.
 * @param state - preceding immutable projection.
 * @param event - candidate event in sequence order.
 * @returns the next detached projection, or the same object for unrelated events.
 */
export function applyTaskEvent(state: TaskFoldState, event: SessionEvent): TaskFoldState {
  try {
    switch (event.type) {
      case 'task/worktree-assigned': {
        const data = exactRecord(event.data, ['assignment'], 'task/worktree-assigned data')
        if (state.assignment !== undefined) throw new Error('worktree assignment already exists')
        return { ...state, assignment: decodeWorktreeAssignment(data['assignment']), updatedAt: event.time }
      }
      case 'task/defined': {
        const data = exactRecord(event.data, ['definition'], 'task/defined data')
        return { ...state, definition: decodeDefinition(data['definition']), reviewDecision: undefined, updatedAt: event.time }
      }
      case 'task/criterion-updated': {
        const data = exactRecord(event.data, ['criterion'], 'task/criterion-updated data')
        const criterion = decodeCriterion(data['criterion'])
        if (state.definition === undefined) throw new Error('criterion update requires a current definition')
        const index = state.definition.criteria.findIndex(current => current.id === criterion.id)
        if (index < 0) throw new Error(`criterion "${criterion.id}" does not exist`)
        const current = state.definition.criteria[index]
        /* v8 ignore next -- findIndex returned this in-range index */
        if (current === undefined) throw new Error(`criterion "${criterion.id}" does not exist`)
        validateCriterionTransition(current.status, criterion.status)
        const criteria = [...state.definition.criteria]
        criteria[index] = criterion
        return { ...state, definition: { ...state.definition, criteria }, updatedAt: event.time }
      }
      case 'task/risk-recorded': {
        const data = exactRecord(event.data, ['risk'], 'task/risk-recorded data')
        const risk = decodeRisk(data['risk'])
        const risks = [...state.risks]
        const index = risks.findIndex(current => current.id === risk.id)
        if (index < 0) risks.push(risk)
        else risks[index] = risk
        return { ...state, risks, updatedAt: event.time }
      }
      case 'task/review-decided': {
        const data = exactRecord(event.data, ['decision'], 'task/review-decided data')
        const decision = decodeDecision(data['decision'])
        validateReview(state, decision)
        return { ...state, reviewDecision: decision, updatedAt: event.time }
      }
      case 'task/review-committed': {
        const data = exactRecord(event.data, ['receipt'], 'task/review-committed data')
        if (state.commitReceipt !== undefined) throw new Error('commit receipt already exists')
        if (state.discardReceipt !== undefined) throw new Error('commit cannot follow discard')
        if (state.reviewDecision !== 'ready') throw new Error('commit requires a ready decision')
        const receipt = decodeCommitReceipt(data['receipt'])
        const assignment = assertReceiptOwner(state, receipt, 'commit')
        if (receipt.branch !== assignment.branch) throw new Error('commit receipt branch does not match the worktree assignment')
        return { ...state, commitReceipt: receipt, updatedAt: event.time }
      }
      case 'task/review-applied': {
        const data = exactRecord(event.data, ['receipt'], 'task/review-applied data')
        if (state.commitReceipt === undefined) throw new Error('apply requires a recorded commit')
        if (state.applyReceipt !== undefined) throw new Error('apply receipt already exists')
        if (state.discardReceipt !== undefined) throw new Error('apply cannot follow discard')
        const receipt = decodeApplyReceipt(data['receipt'])
        assertReceiptOwner(state, receipt, 'apply')
        if (receipt.commit !== state.commitReceipt.commit) throw new Error('apply receipt commit does not match the recorded commit')
        if (receipt.reviewRevision !== state.commitReceipt.committedRevision) {
          throw new Error('apply receipt reviewRevision does not match the committed revision')
        }
        if (receipt.sourceHeadBefore !== receipt.sourceHeadAfter) throw new Error('apply receipt must not change source HEAD')
        return { ...state, applyReceipt: receipt, updatedAt: event.time }
      }
      case 'task/review-discarded': {
        const data = exactRecord(event.data, ['receipt'], 'task/review-discarded data')
        if (state.discardReceipt !== undefined) throw new Error('discard receipt already exists')
        if (state.reviewDecision !== 'ready' && state.commitReceipt === undefined && state.applyReceipt === undefined) {
          throw new Error('discard requires a ready decision or recorded delivery')
        }
        const receipt = decodeDiscardReceipt(data['receipt'])
        const assignment = assertReceiptOwner(state, receipt, 'discard')
        if (receipt.branch !== assignment.branch) throw new Error('discard receipt branch does not match the worktree assignment')
        if (state.commitReceipt !== undefined) {
          if (receipt.reviewRevision !== state.commitReceipt.committedRevision) {
            throw new Error('discard receipt reviewRevision does not match the committed revision')
          }
          if (receipt.recoverableCommit !== state.commitReceipt.commit) {
            throw new Error('discard receipt recoverableCommit does not match the recorded commit')
          }
        }
        return { ...state, discardReceipt: receipt, updatedAt: event.time }
      }
      default:
        return state
    }
  } catch (error) {
    /* v8 ignore next -- owned decoders and transition checks throw Error instances */
    const message = error instanceof Error ? error.message : String(error)
    throw new TaskLogError(event.seq, message, { cause: error })
  }
}

/**
 * Replay durable task facts from one contiguous Session event log.
 * @param events - events in sequence order.
 * @returns a detached strict task projection.
 */
export function foldTask(events: readonly SessionEvent[]): TaskFoldState {
  let state = emptyTaskFoldState()
  for (const event of events) state = applyTaskEvent(state, event)
  return state
}
