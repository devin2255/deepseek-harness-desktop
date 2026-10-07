/** Root authority and real Git execution through the model-facing writer tools. */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CallId } from '@deepseek-ai/dsh-llm'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import TaskSession from '@deepseek-ai/dsh-task-session'
import Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { TaskCommitReceipt, TaskFileDiff, TaskIntegrationResult, TaskReviewSummary } from '@deepseek-ai/dsh-task-review'
import { cleanupFixtures, git, mount, repository } from '../../../task/task-review-local/tests/fixture.ts'
import * as Integration from '../src/integrate.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  cleanupFixtures()
})

async function setup() {
  const fixture = repository()
  const { ctx, assignment } = await mount(fixture)
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Jsonl, { root: join(fixture.home, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: fixture.source })
  await ctx.plugin(TaskSession)
  const fiber = ctx.plugin(Integration)
  await fiber
  const parent = ctx.agentLoop.create(assignment.taskId, { provider: 'mock', model: 'mock' }, { cwd: assignment.path })
  parent.session.append('task/worktree-assigned', { assignment })
  const child = await ctx.taskWorktrees.create({ taskId: SessionId('child'), workspaceId: assignment.workspaceId, workspacePath: assignment.path })
  const session = ctx.sessions.prepare(child.taskId, { meta: { origin: 'subagent', parentSession: parent.id, cwd: child.path } })
  const detach = ctx.sessions.enter(session)
  ctx.sessions.announce(session)
  session.append('subagent/worktree-assigned', { parentTaskId: parent.id, assignment: child })
  writeFileSync(join(child.path, 'child.txt'), 'writer change\n')
  let sequence = 0
  const call = (name: string, args: object, agent = parent) => ctx.tools.execute({
    name, arguments: args, callId: CallId(`integration-${++sequence}`), signal: new AbortController().signal, agent,
  })
  return { ctx, assignment, parent, child, session, call, fiber, fixture, detach }
}

function value(result: Awaited<ReturnType<Context['tools']['execute']>>): unknown {
  expect(result.isError, JSON.stringify(result.content)).toBe(false)
  const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
  return JSON.parse(text)
}

it('reviews a member diff, commits the exact revision, and integrates through all three tools', async () => {
  const { ctx, parent, call, assignment, child, fixture } = await setup()
  const review = (value(await call('review_agent_changes', { subagent_id: child.taskId, path: 'child.txt' })) as { rootRevision: string; summary: TaskReviewSummary; diff: TaskFileDiff })
  expect(review.diff.patch).toContain('+writer change')
  const committed = (value(await call('commit_agent_changes', { subagent_id: child.taskId, revision: review.summary.revision, message: 'Writer result' })) as TaskCommitReceipt)
  const other = await ctx.taskWorktrees.create({ taskId: SessionId('other-writer'), workspaceId: assignment.workspaceId, workspacePath: assignment.path })
  const otherSession = ctx.sessions.create(other.taskId, { meta: { origin: 'subagent', parentSession: parent.id, cwd: other.path } })
  otherSession.append('subagent/worktree-assigned', { parentTaskId: parent.id, assignment: other })
  writeFileSync(join(other.path, 'child.txt'), 'conflicting result\n')
  const otherReview = (value(await call('review_agent_changes', { subagent_id: other.taskId })) as { summary: TaskReviewSummary })
  const otherCommit = (value(await call('commit_agent_changes', { subagent_id: other.taskId, revision: otherReview.summary.revision, message: 'Other result' })) as TaskCommitReceipt)
  const conflict = (value(await call('integrate_agents', { root_revision: review.rootRevision, message: 'Conflicting batch', writers: [
    { subagent_id: child.taskId, revision: committed.committedRevision, commit: committed.commit },
    { subagent_id: other.taskId, revision: otherCommit.committedRevision, commit: otherCommit.commit },
  ] })) as TaskIntegrationResult)
  expect(conflict).toMatchObject({ kind: 'conflict', paths: ['child.txt'] })
  expect(git(assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(assignment.baseCommit)
  const result = (value(await call('integrate_agents', { root_revision: review.rootRevision, message: 'Integrate result',
    writers: [{ subagent_id: child.taskId, revision: committed.committedRevision, commit: committed.commit }] })) as TaskIntegrationResult)
  expect(result.kind).toBe('integrated')
  if (result.kind !== 'integrated') throw new Error('expected integration receipt')
  expect(git(assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(result.headAfter)
  expect(git(fixture.source, ['rev-parse', 'HEAD']).trim()).toBe(assignment.baseCommit)
  expect(git(child.path, ['rev-parse', 'HEAD']).trim()).toBe(committed.commit)
}, 30_000)

it('rejects missing, stale, non-root, read-only, and active writer authority through the executor', async () => {
  const { ctx, call, parent, child } = await setup()
  const request = { subagent_id: child.taskId }
  const missing = await ctx.tools.execute({ signal: new AbortController().signal, callId: CallId('no-agent'), name: 'review_agent_changes', arguments: request })
  expect(missing.isError).toBe(true)
  expect(JSON.stringify(missing.content)).toContain('registered calling agent')
  expect((await call('review_agent_changes', request, { ...parent })).isError).toBe(true)
  const nonRoot = ctx.agentLoop.create(SessionId('other'), { provider: 'mock', model: 'mock' })
  expect((await call('review_agent_changes', request, nonRoot)).isError).toBe(true)
  parent.session.append('sandbox/mode', { mode: 'read-only' })
  expect((await call('commit_agent_changes', { ...request, revision: 'stale', message: 'Do not write' })).isError).toBe(true)
  expect((await call('integrate_agents', { root_revision: 'stale', message: 'Do not write', writers: [] })).isError).toBe(true)
  expect((await call('review_agent_changes', request)).isError).toBe(false)
  const originalGet = ctx.agents.get.bind(ctx.agents)
  const busy = vi.spyOn(ctx.agents, 'get').mockImplementation(id => id === child.taskId ? parent : originalGet(id))
  expect((await call('review_agent_changes', request)).isError).toBe(true)
  busy.mockRestore()
}, 30_000)

it('checks cold persisted ownership, rejects a resumed writer, and removes all tools on unload', async () => {
  const { ctx, call, parent, child, session, fiber, detach } = await setup()
  await ctx.sessions.flush(session)
  detach()
  expect((value(await call('review_agent_changes', { subagent_id: child.taskId })) as { summary: TaskReviewSummary }).summary.taskId).toBe(child.taskId)
  const inspect = ctx.sessionPersistence.inspect.bind(ctx.sessionPersistence)
  const resumed = vi.spyOn(ctx.sessionPersistence, 'inspect').mockImplementation(async (id, signal) => {
    const result = await inspect(id, signal)
    vi.spyOn(ctx.agents, 'get').mockImplementation(target => target === child.taskId ? parent : target === parent.id ? parent : undefined)
    return result
  })
  expect((await call('review_agent_changes', { subagent_id: child.taskId })).isError).toBe(true)
  resumed.mockRestore()
  vi.restoreAllMocks()
  const foreign = vi.spyOn(ctx.sessionPersistence, 'inspect').mockImplementation(async (id, signal) => {
    const result = await inspect(id, signal)
    return { ...result, meta: { ...result.meta, parentSession: SessionId('another-root') } }
  })
  expect((await call('review_agent_changes', { subagent_id: child.taskId })).isError).toBe(true)
  foreign.mockRestore()
  vi.restoreAllMocks()
  await fiber.dispose()
  for (const name of ['review_agent_changes', 'commit_agent_changes', 'integrate_agents']) expect(ctx.tools.get(name)).toBeUndefined()
}, 30_000)
