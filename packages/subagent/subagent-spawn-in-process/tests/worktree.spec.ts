import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import Subagents from '@deepseek-ai/dsh-subagent'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Approval, { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import LocalWorktrees from '@deepseek-ai/dsh-task-worktree-local'
import LocalReview from '@deepseek-ai/dsh-task-review-local'
import TaskSession from '@deepseek-ai/dsh-task-session'
import FsSandbox from '@deepseek-ai/dsh-fs-sandbox'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { removeFixtureSafely } from '../../../../scripts/test-fixture-cleanup.ts'
import * as Spawn from '../src/index.ts'
import * as Companion from '../src/invariant.ts'
import { validateIsolatedWriter } from '../src/worktree.ts'

const fixtures: { root: string; ctx: Context }[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

class WriterAdapter extends LlmAdapter {
  constructor(private readonly gate: Promise<void>) { super() }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await this.gate
    const name = JSON.stringify(options.messages).includes('writer-a') ? 'writer-a' : 'writer-b'
    const wrote = options.messages.some(message => message.content.some(block => block.type === 'tool-result'))
    yield* wrote ? textResponse(`${name} done`) : toolCallResponse(`${name}-write`, 'write', { file_path: 'writer.txt', content: name })
  }
}

async function setup(reviewAvailable = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-child-worktrees-'))
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, ['init'])
  git(source, ['config', 'core.autocrlf', 'false'])
  git(source, ['config', 'user.name', 'Writer Fixture'])
  git(source, ['config', 'user.email', 'fixture@localhost'])
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  git(source, ['add', '.'])
  git(source, ['commit', '-m', 'base'])
  const ctx = new Context()
  fixtures.push({ root, ctx })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(Companion)
  await ctx.plugin(SessionJsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Subagents)
  await ctx.plugin(SandboxPolicy, { mode: 'workspace-write', workspaceRoot: source, delegationMode: 'read-only' })
  await ctx.plugin(Approval)
  await ctx.plugin(LocalSubprocess)
  await ctx.plugin(LocalWorktrees, { dshHome: join(root, 'home'), minFreeBytes: 0 })
  if (reviewAvailable) await ctx.plugin(LocalReview)
  await ctx.plugin(TaskSession)
  await ctx.plugin(FsSandbox)
  await ctx.plugin(ToolFs)
  await ctx.plugin(Spawn, { providerName: 'writer', workspaceMode: 'isolated-worktree' })
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  const assignment = await ctx.taskWorktrees.create({ taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'), workspacePath: source })
  const parent = ctx.agentLoop.create(assignment.taskId, { provider: 'fixture', model: 'fixture' }, { cwd: assignment.path })
  parent.session.append('task/worktree-assigned', { assignment })
  // Continuation settlement wakes the parent; this model fixture scripts only child writes.
  ctx.on('agent/pre-step', async ({ agent }, next) => agent === parent ? { kind: 'reject' as const } : next())
  return { ctx, parent, assignment, source: realpathSync(source) }
}

afterEach(async () => {
  for (const { root, ctx } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    removeFixtureSafely(root)
  }
})

it('runs two actual writers in distinct checkouts and persists their execution identities', async () => {
  const { ctx, parent, assignment, source } = await setup()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  ctx.llm.registerAdapter(['fixture'], new WriterAdapter(gate))
  const startWriter = (name: string) => ctx.subagents.start('writer', {
    parent, label: name, prompt: [{ type: 'text', text: name }], signal: new AbortController().signal,
  })
  const [a, b] = await Promise.all([startWriter('writer-a'), startWriter('writer-b')])
  try {
    const first = ctx.agents.get(a.id)!
    const second = ctx.agents.get(b.id)!
    expect(first.status).toBe('running')
    expect(second.status).toBe('running')
    const firstWorkspace = Spawn.foldSubagentWorktree(first.session.events)!
    const secondWorkspace = Spawn.foldSubagentWorktree(second.session.events)!
    expect(firstWorkspace.parentTaskId).toBe(parent.id)
    expect(firstWorkspace.assignment.path).not.toBe(secondWorkspace.assignment.path)
    expect(firstWorkspace.assignment.baseCommit).toBe(secondWorkspace.assignment.baseCommit)
    expect(firstWorkspace.assignment.sourcePath).toBe(assignment.path)
    expect(ctx.sandboxPolicy.resolve({ session: first.session })).toMatchObject({ mode: 'workspace-write', workspaceRoot: firstWorkspace.assignment.path })
    expect(effectiveApprovalPolicy(first.session.events)).toBe('never')
    release()
    expect((await Promise.all([a.result, b.result])).map(result => result.stopReason)).toEqual(['completed', 'completed'])
    expect(readFileSync(join(firstWorkspace.assignment.path, 'writer.txt'), 'utf8')).toBe('writer-a')
    expect(readFileSync(join(secondWorkspace.assignment.path, 'writer.txt'), 'utf8')).toBe('writer-b')
    expect(existsSync(join(assignment.path, 'writer.txt'))).toBe(false)
    expect(existsSync(join(source, 'writer.txt'))).toBe(false)
    expect(git(assignment.path, ['status', '--porcelain=v1'])).toBe('')
    expect(git(source, ['rev-parse', 'HEAD']).trim()).toBe(assignment.baseCommit)
    await Promise.all([a.dispose(), b.dispose()])
    const persisted = await ctx.sessionPersistence.inspect(a.id)
    expect(Spawn.foldSubagentWorktree(persisted.events)).toEqual(firstWorkspace)
    expect(persisted.meta.cwd).toBe(firstWorkspace.assignment.path)
  } finally {
    release()
    await Promise.all([a.dispose(), b.dispose()])
  }
}, 30_000)

it('rejects direct writer delegation from a read-only root without creating a worktree', async () => {
  const { ctx, parent, source } = await setup()
  parent.session.append('sandbox/mode', { mode: 'read-only' })
  const before = git(source, ['worktree', 'list', '--porcelain'])
  await expect(ctx.subagents.start('writer', {
    parent, prompt: [{ type: 'text', text: 'write' }], signal: new AbortController().signal,
  })).rejects.toThrow('cannot gain write authority')
  expect(git(source, ['worktree', 'list', '--porcelain'])).toBe(before)
}, 30_000)

it('rejects uncommitted integration changes before publishing a writer', async () => {
  const { ctx, parent, assignment, source } = await setup()
  writeFileSync(join(assignment.path, 'root-edit.txt'), 'pending root edit\n')
  const before = git(source, ['worktree', 'list', '--porcelain'])
  await expect(ctx.subagents.start('writer', {
    parent, prompt: [{ type: 'text', text: 'write' }], signal: new AbortController().signal,
  })).rejects.toMatchObject({ code: 'WORKTREE_SOURCE_DIRTY' })
  expect(ctx.agents.list()).toHaveLength(1)
  expect(git(source, ['worktree', 'list', '--porcelain'])).toBe(before)
}, 30_000)

it('clamps full root authority and rejects further writer delegation from a child', async () => {
  const { ctx, parent, source } = await setup()
  parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
  const gate = Promise.withResolvers<undefined>()
  ctx.llm.registerAdapter(['fixture'], new WriterAdapter(gate.promise))
  const run = await ctx.subagents.start('writer', {
    parent, prompt: [{ type: 'text', text: 'write' }], signal: new AbortController().signal,
  })
  try {
    const child = ctx.agents.get(run.id)!
    expect(ctx.sandboxPolicy.resolve({ session: child.session }).mode).toBe('workspace-write')
    const before = git(source, ['worktree', 'list', '--porcelain'])
    await expect(ctx.subagents.start('writer', {
      parent: child, prompt: [{ type: 'text', text: 'write again' }], signal: new AbortController().signal,
    })).rejects.toThrow('only a root Task')
    expect(git(source, ['worktree', 'list', '--porcelain'])).toBe(before)
  } finally {
    gate.resolve(undefined)
    await run.dispose()
  }
}, 30_000)

it('advertises writer validation and does not retain a provider after unload', async () => {
  const { ctx, parent } = await setup()
  expect(typeof ctx.subagents.getProvider('writer')!.prepareContinuable).toBe('function')
  expect(typeof ctx.subagents.getProvider('writer')!.validateContinuableExecution).toBe('function')
  expect(await ctx.subagents.getProvider('spawn')!.prepareContinuable!({ parent, sessionId: SessionId('shared-child'), signal: new AbortController().signal })).toEqual({})
  const plugin = ctx.plugin(Spawn, { providerName: 'temporary-writer', workspaceMode: 'isolated-worktree' })
  await plugin
  expect(ctx.subagents.getProvider('temporary-writer')).toBeDefined()
  await plugin.dispose()
  expect(ctx.subagents.getProvider('temporary-writer')).toBeUndefined()
}, 30_000)

class ContinuingWriterAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const transcript = JSON.stringify(options.messages)
    const name = transcript.includes('second-pass') ? 'second-pass' : 'first-pass'
    yield* transcript.includes(`${name}-write`)
      ? textResponse(`${name} done`)
      : toolCallResponse(`${name}-write`, 'write', { file_path: `${name}.txt`, content: name })
  }
}

it('cold-resumes a continuable writer in its recorded checkout without copying parent authority', async () => {
  const { ctx, parent, assignment, source } = await setup()
  ctx.llm.registerAdapter(['fixture'], new ContinuingWriterAdapter())
  const started = await ctx.subagents.startContinuable({
    provider: 'writer', label: 'writer', request: { parent, prompt: [{ type: 'text', text: 'first-pass' }] },
    signal: new AbortController().signal,
  })
  await expect.poll(() => ctx.agents.get(started.childId), { timeout: 15_000 }).toBeUndefined()
  const first = await ctx.sessionPersistence.inspect(started.childId)
  const recorded = Spawn.foldSubagentWorktree(first.events)!
  expect(readFileSync(join(recorded.assignment.path, 'first-pass.txt'), 'utf8')).toBe('first-pass')
  parent.session.append('sandbox/mode', { mode: 'danger-full-access' })
  await ctx.subagents.followup(parent, started.childId, [{ type: 'text', text: 'second-pass' }], {
    source: { kind: 'user' }, signal: new AbortController().signal,
  })
  await expect.poll(() => ctx.agents.get(started.childId), { timeout: 15_000 }).toBeUndefined()
  const second = await ctx.sessionPersistence.inspect(started.childId)
  expect(second.meta.cwd).toBe(recorded.assignment.path)
  expect(Spawn.foldSubagentWorktree(second.events)).toEqual(recorded)
  expect(second.events.filter(event => event.type === 'subagent/execution-provider')).toHaveLength(1)
  expect(second.events.filter(event => event.type === 'sandbox/mode')).toMatchObject([{ data: { mode: 'workspace-write' } }])
  expect(readFileSync(join(recorded.assignment.path, 'second-pass.txt'), 'utf8')).toBe('second-pass')
  expect(git(assignment.path, ['status', '--porcelain=v1'])).toBe('')
  expect(git(source, ['status', '--porcelain=v1'])).toBe('')
}, 30_000)

it('rejects cold publication when a writer checkout loses its registered branch identity', async () => {
  const { ctx, parent } = await setup()
  ctx.llm.registerAdapter(['fixture'], new ContinuingWriterAdapter())
  const started = await ctx.subagents.startContinuable({
    provider: 'writer', label: 'writer', request: { parent, prompt: [{ type: 'text', text: 'first-pass' }] },
    signal: new AbortController().signal,
  })
  await expect.poll(() => ctx.agents.get(started.childId), { timeout: 15_000 }).toBeUndefined()
  const before = await ctx.sessionPersistence.inspect(started.childId)
  const recorded = Spawn.foldSubagentWorktree(before.events)!
  git(recorded.assignment.path, ['checkout', '--detach'])
  await expect(ctx.subagents.followup(parent, started.childId, [{ type: 'text', text: 'second-pass' }], {
    source: { kind: 'user' }, signal: new AbortController().signal,
  })).rejects.toMatchObject({ code: 'NOT_RESUMABLE', cause: { code: 'WORKTREE_UNAVAILABLE' } })
  expect(ctx.agents.get(started.childId)).toBeUndefined()
  expect(existsSync(join(recorded.assignment.path, 'second-pass.txt'))).toBe(false)
}, 30_000)

it('rejects contradictory durable writer metadata and elevated policies, but permits reduced authority', async () => {
  const { ctx, parent } = await setup()
  ctx.llm.registerAdapter(['fixture'], new ContinuingWriterAdapter())
  const started = await ctx.subagents.startContinuable({
    provider: 'writer', label: 'writer', request: { parent, prompt: [{ type: 'text', text: 'first-pass' }] },
    signal: new AbortController().signal,
  })
  await expect.poll(() => ctx.agents.get(started.childId), { timeout: 15_000 }).toBeUndefined()
  const saved = await ctx.sessionPersistence.inspect(started.childId)
  const request = { sessionId: started.childId, parent, meta: saved.meta, events: saved.events, signal: new AbortController().signal }
  const { origin, ...ordinaryMeta } = saved.meta
  expect(origin).toBe('subagent')
  for (const meta of [
    { ...saved.meta, cwd: parent.session.header.cwd! },
    { ...saved.meta, parentSession: SessionId('other') },
    ordinaryMeta,
  ]) await expect(validateIsolatedWriter({ ...request, meta })).rejects.toThrow('does not match')
  await expect(validateIsolatedWriter({ ...request, events: saved.events.filter(event => event.type !== 'subagent/worktree-assigned') }))
    .rejects.toThrow('does not match')
  for (const mode of ['danger-full-access', undefined] as const) {
    const events = saved.events.flatMap<SessionEvent>(event => event.type !== 'sandbox/mode' ? [event]
      : mode === undefined ? [] : [{ ...event, data: { ...event.data, mode } }])
    await expect(validateIsolatedWriter({ ...request, events })).rejects.toThrow('non-escalating')
  }
  await expect(validateIsolatedWriter({ ...request,
    events: saved.events.filter(event => event.type !== 'approval/policy'),
  })).rejects.toThrow('non-escalating')
  await expect(validateIsolatedWriter({ ...request, events: saved.events.map(event => event.type === 'sandbox/mode'
    ? { ...event, data: { ...event.data, mode: 'read-only' as const } } : event) })).resolves.toBeUndefined()
}, 30_000)

it('rejects a missing review capability without creating or publishing a writer', async () => {
  const { ctx, parent, source } = await setup(false)
  const before = git(source, ['worktree', 'list', '--porcelain'])
  await expect(ctx.subagents.start('writer', {
    parent, prompt: [{ type: 'text', text: 'write' }], signal: new AbortController().signal,
  })).rejects.toThrow('isolated subagent writers require')
  expect(ctx.agents.list()).toHaveLength(1)
  expect(git(source, ['worktree', 'list', '--porcelain'])).toBe(before)
}, 30_000)

it('resolves omitted workspace mode to shared execution for typed composition callers', async () => {
  const { ctx } = await setup()
  await ctx.plugin(Object.assign((scope: Context) => { Spawn.apply(scope, { providerName: 'shared-without-mode' }) }, { inject: Spawn.inject }))
  expect(typeof ctx.subagents.getProvider('shared-without-mode')!.prepareContinuable).toBe('function')
}, 30_000)
