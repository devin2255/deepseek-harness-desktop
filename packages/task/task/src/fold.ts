/** Strict replay fold for durable root-task facts. */

import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
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
  'changes-requested', 'ready', 'committed', 'applied', 'archived', 'discarded',
])

/** Result of replaying durable task facts from one root Session. */
export interface TaskFoldState {
  readonly definition: TaskDefinition | undefined
  readonly risks: readonly TaskRisk[]
  readonly reviewDecision: TaskReviewDecision | undefined
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
  return { definition: undefined, risks: [], reviewDecision: undefined, updatedAt: undefined }
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
  if (decision === 'committed' && state.reviewDecision !== 'ready') {
    throw new Error('committed requires a ready decision')
  }
  if (decision === 'applied' && state.reviewDecision !== 'committed') {
    throw new Error('applied requires a committed decision')
  }
  if (decision === 'archived' && state.reviewDecision !== 'applied') {
    throw new Error('archived requires an applied decision')
  }
  if ((decision === 'changes-requested' || decision === 'discarded') && state.definition === undefined) {
    throw new Error(`${decision} requires a current definition`)
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
