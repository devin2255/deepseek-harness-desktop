import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionStore, { Session, SessionId, type CreateSessionOptions } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it } from 'vitest'
import { foldSubagentWorktree, type SubagentWorktreeData } from '../src/index.ts'
import * as Companion from '../src/invariant.ts'

const record: SubagentWorktreeData = {
  parentTaskId: SessionId('parent'),
  assignment: {
    kind: 'git-worktree', taskId: SessionId('child'), workspaceId: WorkspaceId('workspace'),
    sourcePath: resolve('integration'), path: resolve('writer'), branch: `dsh/task-${'a'.repeat(24)}`,
    baseCommit: '1'.repeat(40), sourceHead: '1'.repeat(40), sourceDirty: false,
    sourceStatusDigest: 'b'.repeat(64), createdAt: 1,
  },
}
const meta = {
  cwd: record.assignment.path, parentSession: record.parentTaskId, origin: 'subagent' as const,
} satisfies NonNullable<CreateSessionOptions['meta']>
const contexts: Context[] = []

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  return ctx
}

function event(data: unknown) {
  return Session.create(SessionId('record-fixture')).append('subagent/worktree-assigned', data as never)
}

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

it('decodes detached child execution facts and leaves shared children unassigned', () => {
  expect(foldSubagentWorktree([])).toBeUndefined()
  const decoded = foldSubagentWorktree([event(record)])!
  expect(decoded).toEqual(record)
  expect(decoded.assignment).not.toBe(record.assignment)
})

it.each([
  null, [], { ...record, extra: true }, { ...record, parentTaskId: 1 },
  { ...record, parentTaskId: '' }, { ...record, parentTaskId: ' parent ' },
  { ...record, assignment: { ...record.assignment, path: record.assignment.sourcePath } },
])('rejects malformed persisted writer data %#', (data) => {
  expect(() => foldSubagentWorktree([event(data)])).toThrow()
})

it('rejects repeated execution assignments', () => {
  expect(() => foldSubagentWorktree([event(record), event(record)])).toThrow('exactly once')
})

it('checks seeded and newly published children without treating inherited assignments as owned', async () => {
  const ctx = await setup()
  const existing = ctx.sessions.create(record.assignment.taskId, { meta, seed: [event(record)] })
  await ctx.plugin(Companion)
  expect(foldSubagentWorktree(existing.events)).toEqual(record)
  expect(() => ctx.sessions.create(SessionId('fork'), {
    meta: { ...meta, seedLength: 1 }, seed: [event(record)],
  })).not.toThrow()
  const child = ctx.sessions.create(SessionId('second'), { meta })
  expect(() => child.append('subagent/worktree-assigned', {
    ...record, assignment: { ...record.assignment, taskId: child.id },
  })).not.toThrow()
  expect(() => child.append('subagent/worktree-assigned', record)).toThrow('exactly once')
  expect(child.seq).toBe(1)
})

it.each([
  { ...meta, cwd: record.assignment.sourcePath },
  { ...meta, parentSession: SessionId('other') },
  { cwd: meta.cwd, parentSession: meta.parentSession },
])('rejects an assignment that contradicts the actual Session metadata %#', async (invalidMeta) => {
  const ctx = await setup()
  await ctx.plugin(Companion)
  const child = ctx.sessions.create(record.assignment.taskId, { meta: invalidMeta })
  expect(() => child.append('subagent/worktree-assigned', record)).toThrow('does not match its Session')
  expect(child.seq).toBe(0)
})

it('rejects a foreign Session identity and malformed facts before append', async () => {
  const ctx = await setup()
  await ctx.plugin(Companion)
  const child = ctx.sessions.create(SessionId('other'), { meta })
  expect(() => child.append('subagent/worktree-assigned', record)).toThrow('does not match its Session')
  expect(() => child.append('subagent/worktree-assigned', { ...record, parentTaskId: '' } as never)).toThrow('invalid subagent worktree record')
  expect(child.seq).toBe(0)
})

it('vetoes publication of a restored child with contradictory execution facts', async () => {
  const ctx = await setup()
  await ctx.plugin(Companion)
  expect(() => ctx.sessions.create(SessionId('other'), { meta, seed: [event(record)] })).toThrow('does not match its Session')
  expect(ctx.sessions.get(SessionId('other'))).toBeUndefined()
})

it('removes dispatch validation when the companion unloads', async () => {
  const ctx = await setup()
  const companion = ctx.plugin(Companion)
  await companion
  const child = ctx.sessions.create(record.assignment.taskId, { meta })
  expect(() => child.append('subagent/worktree-assigned', { ...record, parentTaskId: '' } as never)).toThrow()
  await companion.dispose()
  expect(() => child.append('subagent/worktree-assigned', { ...record, parentTaskId: '' } as never)).not.toThrow()
})
