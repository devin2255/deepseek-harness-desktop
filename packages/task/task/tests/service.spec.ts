import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  TaskCriterionId,
  TaskError,
  TaskRiskId,
  TaskService,
} from '@deepseek-ai/dsh-task'
import type {
  AssignTaskWorktreeRequest,
  DefineTaskRequest,
  LiveTaskFact,
  RecordTaskRiskRequest,
  RecordTaskApplyRequest,
  RecordTaskCommitRequest,
  RecordTaskDiscardRequest,
  ReviewTaskRequest,
  TaskErrorCode,
  TaskListChange,
  TaskListSnapshot,
  TaskSnapshot,
  UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task'

const emptyList: TaskListSnapshot = { generation: 0, tasks: [] }

class StubTaskService extends TaskService {
  snapshot(): TaskListSnapshot {
    return emptyList
  }

  onChanged(_listener: (change: TaskListChange) => void): () => void {
    return () => {}
  }

  replaceLiveGeneration(_generation: number, _facts: readonly LiveTaskFact[]): void {}

  invalidateLiveGeneration(_generation: number): void {}

  async assignWorktree(_sessionId: SessionId, _request: AssignTaskWorktreeRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async define(_sessionId: SessionId, _request: DefineTaskRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async updateCriterion(_sessionId: SessionId, _request: UpdateTaskCriterionRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async recordRisk(_sessionId: SessionId, _request: RecordTaskRiskRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async review(_sessionId: SessionId, _request: ReviewTaskRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async recordCommit(_sessionId: SessionId, _request: RecordTaskCommitRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async recordApply(_sessionId: SessionId, _request: RecordTaskApplyRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }

  async recordDiscard(_sessionId: SessionId, _request: RecordTaskDiscardRequest): Promise<TaskSnapshot> {
    throw new TaskError('not implemented', 'TASK_UNAVAILABLE')
  }
}

describe('task Service Definition', () => {
  it('registers exactly one ctx.tasks provider and releases it on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubTaskService)
    expect(ctx.tasks).toBeInstanceOf(StubTaskService)
    await expect(ctx.plugin(StubTaskService)).rejects.toThrow()
    await fiber.dispose()
    expect((ctx as Context & { tasks?: unknown }).tasks).toBeUndefined()
  })

  it('exposes stable machine-routable error codes', () => {
    const code: TaskErrorCode = 'TASK_STALE_SEQUENCE'
    const cause = new Error('root session moved')
    const error = new TaskError('stale task mutation', code, { cause })
    expect(error).toMatchObject({
      name: 'TaskError',
      code: 'TASK_STALE_SEQUENCE',
      cause,
    })
  })

  it('keeps list changes and live facts detached and discriminated', () => {
    const fact = {
      kind: 'activity',
      taskId: SessionId('root'),
      ownerSessionId: SessionId('child'),
      sourceId: 'run-1',
      state: 'running',
      createdAt: 10,
    } satisfies LiveTaskFact
    const change: TaskListChange = {
      generation: 3,
      upserts: [],
      removed: [SessionId('removed')],
    }
    expect(fact.kind).toBe('activity')
    expect(change).toEqual({ generation: 3, upserts: [], removed: ['removed'] })
  })

  it('publishes compare-and-set request types for every mutation', () => {
    expectTypeOf<DefineTaskRequest>().toExtend<{
      readonly goal: string
      readonly criteria: readonly { readonly id?: ReturnType<typeof TaskCriterionId>; readonly text: string }[]
      readonly expectedSeq: number
    }>()
    expectTypeOf<UpdateTaskCriterionRequest['expectedSeq']>().toEqualTypeOf<number>()
    expectTypeOf<RecordTaskRiskRequest['risk']['id']>().toEqualTypeOf<ReturnType<typeof TaskRiskId>>()
    expectTypeOf<ReviewTaskRequest['decision']>().toEqualTypeOf<'changes-requested' | 'ready'>()
    expectTypeOf<TaskSnapshot>().toExtend<{ readonly workspaceId?: WorkspaceId }>()
  })
})
