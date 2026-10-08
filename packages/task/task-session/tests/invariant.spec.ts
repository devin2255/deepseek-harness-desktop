import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { AttentionItemId, type TaskListSnapshot, type TaskSnapshot } from '@deepseek-ai/dsh-task'
import * as TaskSessionInvariant from '../src/invariant.ts'

const sid = SessionId
const row = (overrides: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  taskId: sid('root'), descendantSessionIds: [sid('child')], status: 'settled', freshness: 'live', attention: [], risks: [],
  updatedAt: 1, asOfSeq: 0, ...overrides,
})

async function install(snapshot: TaskListSnapshot) {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  let current = snapshot
  let changed: (() => void) | undefined
  ctx.provide('tasks', {
    snapshot: () => current,
    onChanged: (listener: () => void) => { changed = listener; return () => { changed = undefined } },
  } as never)
  const fiber = ctx.plugin(TaskSessionInvariant)
  return {
    ctx,
    fiber,
    change: (next: TaskListSnapshot) => { current = next; changed?.() },
  }
}

describe('task-session invariants', () => {
  it('validates logged integration ownership and later contributor coverage on published changes', async () => {
    const fixture = JSON.parse(readFileSync(new URL('../../../../scripts/snapshots/task-integration-sdk/task.json', import.meta.url), 'utf8')) as TaskSnapshot
    const test = await install({ generation: 0, tasks: [fixture] })
    await test.fiber
    const nodes = fixture.integrations!
    const unresolved = { ...nodes[0]! }
    delete unresolved.resolvedBy
    const invalid: TaskSnapshot[] = [
      { ...fixture, asOfSeq: 1 },
      { ...fixture, taskId: sid('other') },
      { ...fixture, descendantSessionIds: [] },
      { ...fixture, integrations: [nodes[1]!, nodes[0]!] },
      { ...fixture, integrations: [{ ...nodes[0]!, resolvedBy: nodes[1]!.id }, ...nodes.slice(1)] },
      { ...fixture, integrations: [{ ...nodes[0]!, writerSessionIds: [sid('writer-b')] }, ...nodes.slice(1)] },
      { ...fixture, workspaceId: 'foreign' as never },
      { ...fixture, integrations: [unresolved, ...nodes.slice(1)] },
    ]
    for (const value of invalid) expect(() => { test.change({ generation: 1, tasks: [value] }) }).toThrow(InvariantError)
    expect(() => { test.change({ generation: 2, tasks: [fixture] }) }).not.toThrow()
    await test.ctx.fiber.dispose()
  })

  it('accepts a unique tree and validates later changes', async () => {
    const test = await install({ generation: 0, tasks: [row()] })
    await expect(test.fiber).resolves.toBeDefined()
    expect(() => { test.change({ generation: 1, tasks: [row({ status: 'running' })] }) }).not.toThrow()
  })

  it('rejects duplicate roots and descendants', async () => {
    const duplicateRoot = await install({ generation: 0, tasks: [row(), row()] })
    await expect(duplicateRoot.fiber).rejects.toMatchObject({ packageName: '@deepseek-ai/dsh-task-session' } satisfies Partial<InvariantError>)
    const duplicateChild = await install({ generation: 0, tasks: [
      row(), row({ taskId: sid('other'), descendantSessionIds: [sid('child')] }),
    ] })
    await expect(duplicateChild.fiber).rejects.toThrow(/belongs to more than one Task row/)
    const childIsRoot = await install({ generation: 0, tasks: [
      row(), row({ taskId: sid('child'), descendantSessionIds: [] }),
    ] })
    await expect(childIsRoot.fiber).rejects.toThrow(/belongs to more than one Task row/)
  })

  it('rejects attention assigned to the wrong root or an outside owner', async () => {
    const attention = {
      id: AttentionItemId('item'), taskId: sid('wrong'), ownerSessionId: sid('root'), kind: 'question' as const,
      severity: 'warning' as const, summary: 'question', createdAt: 1, sourceId: 'q', actionable: true,
    }
    const wrongRoot = await install({ generation: 0, tasks: [row({ attention: [attention] })] })
    await expect(wrongRoot.fiber).rejects.toThrow(/wrong root Task/)
    const outsideOwner = await install({ generation: 0, tasks: [row({ attention: [{
      ...attention, taskId: sid('root'), ownerSessionId: sid('outside'),
    }] })] })
    await expect(outsideOwner.fiber).rejects.toThrow(/outside its Task tree/)
  })
})
