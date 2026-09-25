/** Session-backed Task projection and attention Provider. @module @deepseek-ai/dsh-task-session */

import { randomUUID } from 'node:crypto'
import { Service } from '@deepseek-ai/cordis'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  TaskCriterionId,
  TaskError,
  TaskService,
  applyTaskEvent,
  foldTask,
  type DefineTaskRequest,
  type AssignTaskWorktreeRequest,
  type LiveTaskFact,
  type RecordTaskRiskRequest,
  type RecordTaskApplyRequest,
  type RecordTaskCommitRequest,
  type RecordTaskDiscardRequest,
  type ReviewTaskRequest,
  type TaskErrorCode,
  type TaskListChange,
  type TaskListSnapshot,
  type TaskSnapshot,
  type UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { aggregateTasks, type TaskSessionInput } from './aggregate.ts'

export * from './aggregate.ts'

type TaskEventType =
  | 'task/worktree-assigned'
  | 'task/defined'
  | 'task/criterion-updated'
  | 'task/risk-recorded'
  | 'task/review-decided'
  | 'task/review-committed'
  | 'task/review-applied'
  | 'task/review-discarded'

interface TaskEventDataMap {
  readonly 'task/worktree-assigned': Extract<SessionEvent, { type: 'task/worktree-assigned' }>['data']
  readonly 'task/defined': Extract<SessionEvent, { type: 'task/defined' }>['data']
  readonly 'task/criterion-updated': Extract<SessionEvent, { type: 'task/criterion-updated' }>['data']
  readonly 'task/risk-recorded': Extract<SessionEvent, { type: 'task/risk-recorded' }>['data']
  readonly 'task/review-decided': Extract<SessionEvent, { type: 'task/review-decided' }>['data']
  readonly 'task/review-committed': Extract<SessionEvent, { type: 'task/review-committed' }>['data']
  readonly 'task/review-applied': Extract<SessionEvent, { type: 'task/review-applied' }>['data']
  readonly 'task/review-discarded': Extract<SessionEvent, { type: 'task/review-discarded' }>['data']
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function taskFailure(error: unknown, code: TaskErrorCode): TaskError {
  return error instanceof TaskError
    ? error
    : new TaskError(error instanceof Error ? error.message : String(error), code, { cause: error })
}

/** Session and persistence-backed implementation of {@link TaskService}. */
export class TaskSessionProvider extends TaskService {
  static inject = ['sessions', 'sessionPersistence']

  private readonly inputs = new Map<SessionId, TaskSessionInput>()
  private readonly listeners = new Set<(change: TaskListChange) => void>()
  private current: TaskListSnapshot = { generation: 0, tasks: [] }
  private generation = 0
  private liveFacts: readonly LiveTaskFact[] = []
  private freshness: 'live' | 'disconnected' = 'live'
  private invalidated = false
  private operationTail: Promise<void> = Promise.resolve()
  private notificationsOpen = true

  /** Load cold history, overlay live owners, and attach projection subscriptions. */
  protected async [Service.init](): Promise<void> {
    const snapshots = await this.ctx.sessionPersistence.listSnapshots()
    await Promise.all(snapshots.map(async ({ header }) => {
      try {
        const inspected = await this.ctx.sessionPersistence.inspect(header.id)
        this.inputs.set(header.id, { header: inspected.meta, events: inspected.events })
      } catch (error) {
        this.ctx.logger.warn(`task projection could not inspect Session "${header.id}": ${String(error)}`)
        this.inputs.set(header.id, { header })
      }
    }))
    for (const session of this.ctx.sessions.list()) this.captureLive(session)
    this.rebuild(false)

    this.ctx.on('session/created', (session) => {
      this.captureLive(session)
      this.rebuild(true)
    }, { global: true })
    this.ctx.on('session/event', (session) => {
      this.captureLive(session)
      this.rebuild(true)
    }, { global: true })
    this.ctx.on('session/disposed', (session) => {
      void this.enqueue(async () => {
        try {
          const inspected = await this.ctx.sessionPersistence.inspect(session.id)
          this.inputs.set(session.id, { header: inspected.meta, events: inspected.events })
        } catch (error) {
          this.ctx.logger.warn(`task projection could not retain disposed Session "${session.id}": ${String(error)}`)
          this.inputs.delete(session.id)
        }
        this.rebuild(true)
      })
    }, { global: true })
    this.ctx.effect(() => () => {
      this.notificationsOpen = false
      this.listeners.clear()
    }, 'taskSession.notifications')
  }

  /** @inheritdoc */
  snapshot(): TaskListSnapshot {
    return clone(this.current)
  }

  /** @inheritdoc */
  onChanged(listener: (change: TaskListChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Replace all live facts with one authoritative runtime-generation baseline.
   * @param generation - monotonically increasing runtime identity.
   * @param facts - complete live fact set for that generation.
   */
  replaceLiveGeneration(generation: number, facts: readonly LiveTaskFact[]): void {
    if (!Number.isSafeInteger(generation) || generation < 0) throw new TypeError('task generation must be a non-negative safe integer')
    if (generation < this.generation || this.invalidated && generation === this.generation) return
    this.generation = generation
    this.liveFacts = clone(facts)
    this.freshness = 'live'
    this.invalidated = false
    this.rebuild(true)
  }

  /**
   * Mark the current generation disconnected while retaining its last known live facts.
   * @param generation - exact generation being disconnected.
   */
  invalidateLiveGeneration(generation: number): void {
    if (generation !== this.generation || this.invalidated) return
    this.invalidated = true
    this.freshness = 'disconnected'
    this.rebuild(true)
  }

  /** @inheritdoc */
  assignWorktree(sessionId: SessionId, request: AssignTaskWorktreeRequest): Promise<TaskSnapshot> {
    return this.enqueueValue(async () => {
      const input = this.requireRoot(sessionId)
      if (request.assignment.taskId !== sessionId) {
        throw new TaskError(`Worktree Task "${request.assignment.taskId}" does not match "${sessionId}"`, 'TASK_INVALID_WORKTREE')
      }
      if (foldTask(input.events ?? []).assignment !== undefined) {
        throw new TaskError(`Task "${sessionId}" already has an execution worktree`, 'TASK_WORKTREE_ASSIGNED')
      }
      const registry = this.ctx.get('workspaceRegistry')
      const workspace = registry?.get(request.assignment.workspaceId)
      if (workspace === undefined) {
        throw new TaskError(`Workspace "${request.assignment.workspaceId}" does not exist`, 'TASK_INVALID_WORKTREE')
      }
      if (workspace.path !== request.assignment.sourcePath) {
        throw new TaskError(`Worktree source does not match Workspace "${request.assignment.workspaceId}"`, 'TASK_INVALID_WORKTREE')
      }
      return await this.commit(input, request.expectedSeq, 'TASK_INVALID_WORKTREE', 'task/worktree-assigned', {
        assignment: request.assignment,
      })
    })
  }

  /** @inheritdoc */
  define(sessionId: SessionId, request: DefineTaskRequest): Promise<TaskSnapshot> {
    return this.appendCommand(sessionId, request.expectedSeq, 'TASK_INVALID_DEFINITION', 'task/defined', {
      definition: {
        goal: request.goal,
        criteria: request.criteria.map(criterion => ({
          id: criterion.id ?? TaskCriterionId(randomUUID()), text: criterion.text, status: 'pending' as const, evidence: [],
        })),
      },
    })
  }

  /** @inheritdoc */
  updateCriterion(sessionId: SessionId, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot> {
    return this.appendCommand(sessionId, request.expectedSeq, 'TASK_INVALID_CRITERION', 'task/criterion-updated', {
      criterion: request.criterion,
    })
  }

  /** @inheritdoc */
  recordRisk(sessionId: SessionId, request: RecordTaskRiskRequest): Promise<TaskSnapshot> {
    return this.appendCommand(sessionId, request.expectedSeq, 'TASK_INVALID_RISK', 'task/risk-recorded', { risk: request.risk })
  }

  /** @inheritdoc */
  review(sessionId: SessionId, request: ReviewTaskRequest): Promise<TaskSnapshot> {
    return this.enqueueValue(async () => {
      const input = this.requireRoot(sessionId)
      if (request.decision !== 'changes-requested' && this.hasActiveRun(sessionId)) {
        throw new TaskError(`Task "${sessionId}" still has active work`, 'TASK_ACTIVE')
      }
      return await this.commit(input, request.expectedSeq, 'TASK_INVALID_REVIEW', 'task/review-decided', {
        decision: request.decision,
      })
    })
  }

  /** @inheritdoc */
  recordCommit(sessionId: SessionId, request: RecordTaskCommitRequest): Promise<TaskSnapshot> {
    return this.appendTerminalCommand(
      sessionId, request.expectedSeq, 'TASK_INVALID_COMMIT', 'task/review-committed', { receipt: request.receipt },
    )
  }

  /** @inheritdoc */
  recordApply(sessionId: SessionId, request: RecordTaskApplyRequest): Promise<TaskSnapshot> {
    return this.appendTerminalCommand(
      sessionId, request.expectedSeq, 'TASK_INVALID_APPLY', 'task/review-applied', { receipt: request.receipt },
    )
  }

  /** @inheritdoc */
  recordDiscard(sessionId: SessionId, request: RecordTaskDiscardRequest): Promise<TaskSnapshot> {
    return this.appendTerminalCommand(
      sessionId, request.expectedSeq, 'TASK_INVALID_DISCARD', 'task/review-discarded', { receipt: request.receipt },
    )
  }

  private captureLive(session: Session): void {
    this.inputs.set(session.id, { header: session.header, events: session.events })
  }

  private workspaceBySession(): ReadonlyMap<SessionId, WorkspaceId> | undefined {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return undefined
    const result = new Map<SessionId, WorkspaceId>()
    for (const workspace of registry.list()) for (const id of workspace.sessionIds) result.set(id, workspace.id)
    return result
  }

  private rebuild(notify: boolean): void {
    const previous = this.current
    const workspaceBySession = this.workspaceBySession()
    const next = aggregateTasks({
      generation: this.generation,
      sessions: [...this.inputs.values()],
      liveFacts: this.liveFacts,
      freshness: this.freshness,
      ...workspaceBySession === undefined ? {} : { workspaceBySession },
    })
    this.current = next
    if (!notify || !this.notificationsOpen) return
    const before = new Map(previous.tasks.map(task => [task.taskId, task]))
    const upserts = next.tasks.filter(task => JSON.stringify(before.get(task.taskId)) !== JSON.stringify(task))
    const after = new Set(next.tasks.map(task => task.taskId))
    const removed = previous.tasks.map(task => task.taskId).filter(id => !after.has(id))
    if (upserts.length === 0 && removed.length === 0 && previous.generation === next.generation) return
    const change: TaskListChange = clone({ generation: next.generation, upserts, removed })
    for (const listener of [...this.listeners]) {
      try {
        listener(clone(change))
      } catch (error) {
        this.ctx.logger.warn(`task change listener threw: ${String(error)}`)
      }
    }
  }

  private requireRoot(sessionId: SessionId): TaskSessionInput {
    const input = this.inputs.get(sessionId)
    if (input === undefined) throw new TaskError(`Task "${sessionId}" does not exist`, 'TASK_NOT_FOUND')
    if (input.header.origin === 'subagent') throw new TaskError(`Session "${sessionId}" is not a root Task`, 'TASK_TARGET_NOT_ROOT')
    if (input.events === undefined) throw new TaskError(`Task "${sessionId}" is unavailable`, 'TASK_UNAVAILABLE')
    return input
  }

  private treeIds(rootId: SessionId): Set<SessionId> {
    const task = this.current.tasks.find(candidate => candidate.taskId === rootId)
    /* v8 ignore next -- requireRoot and synchronous rebuild retain every root before command validation */
    if (task === undefined) throw new TaskError(`Task "${rootId}" does not exist`, 'TASK_NOT_FOUND')
    return new Set([rootId, ...task.descendantSessionIds])
  }

  private hasActiveRun(rootId: SessionId): boolean {
    return this.liveFacts.some((fact) => {
      if (fact.kind !== 'activity' || fact.taskId !== rootId) return false
      return fact.state === 'running'
    })
  }

  private validateEvidence(rootId: SessionId, event: SessionEvent): void {
    if (event.type !== 'task/criterion-updated') return
    const tree = this.treeIds(rootId)
    for (const evidence of event.data.criterion.evidence) {
      if (!tree.has(evidence.sessionId)) {
        throw new TaskError(`evidence Session "${evidence.sessionId}" is outside Task "${rootId}"`, 'TASK_INVALID_EVIDENCE')
      }
      const source = this.inputs.get(evidence.sessionId)
      if (source?.events?.[evidence.seq] === undefined) {
        throw new TaskError(`evidence event ${evidence.seq} is missing from Session "${evidence.sessionId}"`, 'TASK_INVALID_EVIDENCE')
      }
    }
  }

  private appendCommand<T extends Exclude<TaskEventType, 'task/review-decided'>>(
    sessionId: SessionId,
    expectedSeq: number,
    invalidCode: TaskErrorCode,
    type: T,
    data: TaskEventDataMap[T],
  ): Promise<TaskSnapshot> {
    return this.enqueueValue(async () => this.commit(this.requireRoot(sessionId), expectedSeq, invalidCode, type, data))
  }

  private appendTerminalCommand<T extends 'task/review-committed' | 'task/review-applied' | 'task/review-discarded'>(
    sessionId: SessionId,
    expectedSeq: number,
    invalidCode: TaskErrorCode,
    type: T,
    data: TaskEventDataMap[T],
  ): Promise<TaskSnapshot> {
    return this.enqueueValue(async () => {
      const input = this.requireRoot(sessionId)
      if (this.hasActiveRun(sessionId)) throw new TaskError(`Task "${sessionId}" still has active work`, 'TASK_ACTIVE')
      return await this.commit(input, expectedSeq, invalidCode, type, data)
    })
  }

  private async commit<T extends TaskEventType>(
    input: TaskSessionInput,
    expectedSeq: number,
    invalidCode: TaskErrorCode,
    type: T,
    data: TaskEventDataMap[T],
  ): Promise<TaskSnapshot> {
    const events = input.events
    /* v8 ignore next -- requireRoot rejects unavailable inputs before commit */
    if (events === undefined) throw new TaskError(`Task "${input.header.id}" is unavailable`, 'TASK_UNAVAILABLE')
    if (expectedSeq !== events.length) {
      throw new TaskError(`Task "${input.header.id}" expected sequence ${expectedSeq}, current sequence is ${events.length}`, 'TASK_STALE_SEQUENCE')
    }
    const candidate = clone({ type, seq: events.length, time: Date.now(), data }) as SessionEvent
    try {
      this.validateEvidence(input.header.id, candidate)
      applyTaskEvent(foldTask(events), candidate)
    } catch (error) {
      throw taskFailure(error, invalidCode)
    }
    const live = this.ctx.sessions.get(input.header.id)
    if (live !== undefined) {
      /* v8 ignore next 2 -- Session append publication synchronously refreshes inputs, so a live seq cannot diverge here */
      if (live.seq !== expectedSeq) {
        throw new TaskError(`Task "${input.header.id}" changed before the update`, 'TASK_STALE_SEQUENCE')
      }
      switch (type) {
        case 'task/worktree-assigned':
          live.append('task/worktree-assigned', data as TaskEventDataMap['task/worktree-assigned'])
          break
        case 'task/defined':
          live.append('task/defined', data as TaskEventDataMap['task/defined'])
          break
        case 'task/criterion-updated':
          live.append('task/criterion-updated', data as TaskEventDataMap['task/criterion-updated'])
          break
        case 'task/risk-recorded':
          live.append('task/risk-recorded', data as TaskEventDataMap['task/risk-recorded'])
          break
        case 'task/review-decided':
          live.append('task/review-decided', data as TaskEventDataMap['task/review-decided'])
          break
        case 'task/review-committed':
          live.append('task/review-committed', data as TaskEventDataMap['task/review-committed'])
          break
        case 'task/review-applied':
          live.append('task/review-applied', data as TaskEventDataMap['task/review-applied'])
          break
        case 'task/review-discarded':
          live.append('task/review-discarded', data as TaskEventDataMap['task/review-discarded'])
          break
      }
      this.captureLive(live)
    } else {
      try {
        await this.ctx.sessionPersistence.append(input.header.id, [candidate])
      } catch (error) {
        throw taskFailure(error, 'TASK_STALE_SEQUENCE')
      }
      this.inputs.set(input.header.id, { header: input.header, events: [...events, candidate] })
    }
    this.rebuild(true)
    const task = this.current.tasks.find(current => current.taskId === input.header.id)
    /* v8 ignore next -- rebuilding a retained root always returns its row */
    if (task === undefined) throw new TaskError(`Task "${input.header.id}" disappeared after update`, 'TASK_UNAVAILABLE')
    return clone(task)
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const run = this.operationTail.then(operation, operation)
    /* v8 ignore next -- only disposal uses this void queue and contains its persistence failure internally */
    this.operationTail = run.catch(() => undefined)
    return run
  }

  private enqueueValue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.then(operation, operation)
    this.operationTail = run.then(() => undefined, () => undefined)
    return run
  }
}

export default TaskSessionProvider
