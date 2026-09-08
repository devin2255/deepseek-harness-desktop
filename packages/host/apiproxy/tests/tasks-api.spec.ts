/** Host Task RPC forwarding, validation, error mapping, and change delivery. */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import {
  TaskCriterionId, TaskError, TaskRiskId, TaskService,
} from '@deepseek-ai/dsh-task'
import type {
  DefineTaskRequest, RecordTaskRiskRequest, ReviewTaskRequest, TaskListChange,
  TaskListSnapshot, TaskSnapshot, UpdateTaskCriterionRequest,
} from '@deepseek-ai/dsh-task'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostFrame, RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import {
  taskDefineRequestSchema, taskListChangeSchema, taskSnapshotSchema,
  taskUpdateCriterionRequestSchema,
} from '../src/api/tasks.schema.ts'

const rootId = SessionId('root')
const row: TaskSnapshot = {
  taskId: rootId,
  descendantSessionIds: [],
  status: 'running',
  freshness: 'live',
  attention: [],
  risks: [],
  updatedAt: 10,
  asOfSeq: 2,
}

class FakeTasks extends TaskService {
  readonly listeners = new Set<(change: TaskListChange) => void>()
  nextError?: Error
  last?: readonly [string, SessionId, unknown]

  snapshot(): TaskListSnapshot {
    return { generation: 4, tasks: [row] }
  }

  onChanged(listener: (change: TaskListChange) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(change: TaskListChange): void {
    for (const listener of this.listeners) listener(change)
  }

  private result(method: string, sessionId: SessionId, request: unknown): Promise<TaskSnapshot> {
    this.last = [method, sessionId, request]
    return this.nextError === undefined ? Promise.resolve(row) : Promise.reject(this.nextError)
  }

  define(sessionId: SessionId, request: DefineTaskRequest): Promise<TaskSnapshot> {
    return this.result('define', sessionId, request)
  }

  updateCriterion(sessionId: SessionId, request: UpdateTaskCriterionRequest): Promise<TaskSnapshot> {
    return this.result('updateCriterion', sessionId, request)
  }

  recordRisk(sessionId: SessionId, request: RecordTaskRiskRequest): Promise<TaskSnapshot> {
    return this.result('recordRisk', sessionId, request)
  }

  review(sessionId: SessionId, request: ReviewTaskRequest): Promise<TaskSnapshot> {
    return this.result('review', sessionId, request)
  }
}

function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId('task-test'), payload }
}

async function harness(): Promise<{ ctx: Context; tasks: FakeTasks; api: ReturnType<typeof createApiProxy> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(FakeTasks)
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] } as never)
  return {
    ctx,
    tasks: ctx.tasks as FakeTasks,
    api: createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' }),
  }
}

describe('Task RPC', () => {
  it('returns the service baseline and forwards all normalized mutations', async () => {
    const { api, tasks } = await harness()
    await expect(api.tasks.list(request({}))).resolves.toMatchObject({ result: { ok: true, value: { generation: 4, tasks: [row] } } })

    await api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [{ text: 'Passes' }], expectedSeq: 2 }))
    expect(tasks.last).toEqual(['define', rootId, { goal: 'Ship', criteria: [{ text: 'Passes' }], expectedSeq: 2 }])
    await api.tasks.updateCriterion(request({
      sessionId: rootId,
      criterion: { id: TaskCriterionId('criterion-1'), text: 'Passes', status: 'satisfied', evidence: [{ sessionId: rootId, seq: 2 }] },
      expectedSeq: 3,
    }))
    expect(tasks.last?.[0]).toBe('updateCriterion')
    await api.tasks.recordRisk(request({ sessionId: rootId, risk: { id: TaskRiskId('risk-1'), severity: 'high', summary: 'Signing' }, expectedSeq: 4 }))
    expect(tasks.last?.[0]).toBe('recordRisk')
    await api.tasks.review(request({ sessionId: rootId, decision: 'ready', expectedSeq: 5 }))
    expect(tasks.last).toEqual(['review', rootId, { decision: 'ready', expectedSeq: 5 }])
  })

  it.each([
    ['TASK_NOT_FOUND', 'task-not-found'],
    ['TASK_TARGET_NOT_ROOT', 'task-target-not-root'],
    ['TASK_STALE_SEQUENCE', 'task-stale-sequence'],
    ['TASK_INVALID_DEFINITION', 'task-invalid-definition'],
    ['TASK_INVALID_CRITERION', 'task-invalid-criterion'],
    ['TASK_INVALID_RISK', 'task-invalid-risk'],
    ['TASK_INVALID_REVIEW', 'task-invalid-review'],
    ['TASK_INVALID_EVIDENCE', 'task-invalid-evidence'],
    ['TASK_ACTIVE', 'task-active'],
    ['TASK_UNAVAILABLE', 'task-unavailable'],
  ] as const)('maps %s to %s', async (domainCode, wireCode) => {
    const { api, tasks } = await harness()
    tasks.nextError = new TaskError('rejected', domainCode)
    const response = await api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [], expectedSeq: 2 }))
    expect(response.result).toEqual({ ok: false, error: { code: wireCode, message: 'rejected', details: { sessionId: rootId } } })
  })

  it('reports an absent provider without throwing', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    await expect(api.tasks.list(request({}))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [], expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.updateCriterion(request({ sessionId: rootId, criterion: { id: TaskCriterionId('c1'), text: 'Passes', status: 'pending', evidence: [] }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.recordRisk(request({ sessionId: rootId, risk: { id: TaskRiskId('r1'), severity: 'low', summary: 'Risk' }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
    await expect(api.tasks.review(request({ sessionId: rootId, decision: 'ready', expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-unavailable' } } })
  })

  it('maps failures from every mutation and contains unexpected provider errors', async () => {
    const { api, tasks } = await harness()
    tasks.nextError = new TaskError('stale', 'TASK_STALE_SEQUENCE')
    await expect(api.tasks.updateCriterion(request({ sessionId: rootId, criterion: { id: TaskCriterionId('c1'), text: 'Passes', status: 'pending', evidence: [] }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
    await expect(api.tasks.recordRisk(request({ sessionId: rootId, risk: { id: TaskRiskId('r1'), severity: 'low', summary: 'Risk' }, expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
    await expect(api.tasks.review(request({ sessionId: rootId, decision: 'ready', expectedSeq: 0 }))).resolves.toMatchObject({ result: { ok: false, error: { code: 'task-stale-sequence' } } })
    tasks.nextError = new Error('provider crashed')
    await expect(api.tasks.define(request({ sessionId: rootId, goal: 'Ship', criteria: [], expectedSeq: 0 }))).resolves.toEqual({
      rpcId: RpcId('task-test'),
      result: { ok: false, error: { code: 'internal', message: 'Error: provider crashed', details: {} } },
    })
  })

  it('forwards changes on the host stream and disposes the provider subscription', async () => {
    const { api, tasks } = await harness()
    const abort = new AbortController()
    const iterator = api.events.host(request({}), abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    expect(tasks.listeners.size).toBe(1)
    tasks.emit({ generation: 5, upserts: [row], removed: [] })
    const next = await pending
    expect(next.done).toBe(false)
    expect((next.value as RpcRequest<HostFrame>).payload).toEqual({ type: 'task/changed', generation: 5, upserts: [row], removed: [] })
    abort.abort()
    await iterator.next()
    expect(tasks.listeners.size).toBe(0)
  })
})

describe('Task wire schemas', () => {
  it('rejects unknown fields, blanks, negative sequences, and duplicate criterion ids', () => {
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [], expectedSeq: 0, extra: true }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: ' ', criteria: [], expectedSeq: 0 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [], expectedSeq: -1 }).success).toBe(false)
    expect(taskDefineRequestSchema.safeParse({ sessionId: 'root', goal: 'Ship', criteria: [{ id: 'same', text: 'A' }, { id: 'same', text: 'B' }], expectedSeq: 0 }).success).toBe(false)
  })

  it('rejects invalid evidence and malformed baseline or change discriminants', () => {
    const payload = {
      sessionId: 'root',
      criterion: { id: 'criterion-1', text: 'Passes', status: 'satisfied', evidence: [{ sessionId: 'root', seq: -1 }] },
      expectedSeq: 0,
    }
    expect(taskUpdateCriterionRequestSchema.safeParse(payload).success).toBe(false)
    expect(taskSnapshotSchema.safeParse({ ...row, status: 'waiting' }).success).toBe(false)
    expect(taskListChangeSchema.safeParse({ generation: -1, upserts: [], removed: [] }).success).toBe(false)
  })

  it('validates complete definitions and rejects duplicate projected criterion identities', () => {
    const criterion = { id: 'criterion-1', text: 'Passes', status: 'pending', evidence: [] }
    expect(taskSnapshotSchema.safeParse({ ...row, definition: { goal: 'Ship', criteria: [criterion] } }).success).toBe(true)
    expect(taskSnapshotSchema.safeParse({
      ...row,
      definition: { goal: 'Ship', criteria: [criterion, { ...criterion, text: 'Duplicate' }] },
    }).success).toBe(false)
  })
})
