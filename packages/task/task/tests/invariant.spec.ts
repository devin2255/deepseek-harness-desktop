import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { TaskCriterionId } from '@deepseek-ai/dsh-task'
import * as TaskInvariantCompanion from '@deepseek-ai/dsh-task/invariant'

const definition = {
  goal: 'Ship the desktop product',
  criteria: [{
    id: TaskCriterionId('installer'),
    text: 'Installer launches the application',
    status: 'pending' as const,
    evidence: [],
  }],
}

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(TaskInvariantCompanion)
  return ctx
}

describe('task stream invariants', () => {
  it('accepts a canonical definition and criterion update', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('task-invariant-valid'))
    session.append('task/defined', { definition })
    expect(() => {
      session.append('task/criterion-updated', {
        criterion: {
          ...definition.criteria[0]!,
          status: 'satisfied',
          evidence: [{ sessionId: session.id, seq: 0 }],
        },
      })
    }).not.toThrow()
  })

  it('rejects malformed task facts before commit and keeps the fold reusable', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('task-invariant-invalid'))
    expect(() => {
      session.append('task/defined', {
        definition: { ...definition, extra: true },
      } as never)
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-task',
    }))
    expect(session.seq).toBe(0)
    expect(() => session.append('task/defined', { definition })).not.toThrow()
  })

  it('reconstructs existing task facts before validating later updates', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('task-invariant-late-load'))
    session.append('task/defined', { definition })

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await ctx.plugin(TaskInvariantCompanion)
    expect(() => session.append('task/criterion-updated', {
      criterion: {
        ...definition.criteria[0]!,
        status: 'satisfied',
        evidence: [{ sessionId: session.id, seq: 0 }],
      },
    })).not.toThrow()
  })
})
