import { describe, expect, expectTypeOf, it } from 'vitest'
import { SessionId, type SessionEventMap } from '@deepseek-ai/dsh-session'
import {
  AttentionItemId,
  TaskCriterionId,
  TaskRiskId,
  type TaskDefinition,
  type TaskSnapshot,
} from '@deepseek-ai/dsh-task'

describe('task public vocabulary', () => {
  it('brands identities and exposes whole-value durable events', () => {
    expect(AttentionItemId('attention-1')).toBe('attention-1')
    expect(TaskCriterionId('criterion-1')).toBe('criterion-1')
    expect(TaskRiskId('risk-1')).toBe('risk-1')

    expectTypeOf<SessionEventMap['task/defined']>()
      .toEqualTypeOf<{ readonly definition: TaskDefinition }>()
    expectTypeOf<TaskSnapshot['status']>()
      .toEqualTypeOf<'needs-attention' | 'failed' | 'running' | 'reviewing' | 'ready' | 'settled'>()
  })

  it('keeps evidence tied to an exact event in the task tree', () => {
    const definition: TaskDefinition = {
      goal: 'Ship the desktop product',
      criteria: [{
        id: TaskCriterionId('installer'),
        text: 'The installer launches the application',
        status: 'satisfied',
        evidence: [{ sessionId: SessionId('acceptance-session'), seq: 42 }],
      }],
    }

    expect(definition.criteria[0]?.evidence).toEqual([
      { sessionId: 'acceptance-session', seq: 42 },
    ])
  })
})
