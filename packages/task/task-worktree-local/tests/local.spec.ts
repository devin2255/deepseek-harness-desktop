import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { TaskWorktreeError } from '@deepseek-ai/dsh-task-worktree'
import LocalTaskWorktrees from '@deepseek-ai/dsh-task-worktree-local'
import { removeFixtureSafely } from '../../../../scripts/test-fixture-cleanup.ts'

const fixtures: string[] = []

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function repository(): { root: string; source: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-worktree-'))
  fixtures.push(root)
  const source = join(root, 'source')
  const home = join(root, 'home')
  mkdirSync(source)
  mkdirSync(home)
  git(source, ['init'])
  git(source, ['config', 'user.name', 'DeepSeek Harness Test'])
  git(source, ['config', 'user.email', 'test@localhost'])
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  git(source, ['add', 'tracked.txt'])
  git(source, ['commit', '-m', 'base'])
  return { root, source: resolve(source), home: resolve(home) }
}

async function mount(home: string, config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const worktrees = await ctx.plugin(LocalTaskWorktrees, { dshHome: home, ...config })
  return {
    ctx,
    async dispose(): Promise<void> {
      await worktrees.dispose()
      await subprocess.dispose()
    },
  }
}

afterEach(async () => {
  for (const root of fixtures.splice(0)) removeFixtureSafely(root)
})

describe('local Task worktrees', () => {
  it('creates an isolated branch without changing the source checkout', async () => {
    const fixture = repository()
    const test = await mount(fixture.home)
    const { ctx } = test
    const assignment = await ctx.taskWorktrees.create({
      taskId: SessionId('task-one'),
      workspaceId: WorkspaceId('workspace-one'),
      workspacePath: fixture.source,
    })

    expect(assignment).toMatchObject({
      kind: 'git-worktree',
      taskId: 'task-one',
      workspaceId: 'workspace-one',
      sourcePath: fixture.source,
      sourceDirty: false,
    })
    expect(assignment.baseCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(assignment.sourceHead).toBe(assignment.baseCommit)
    expect(assignment.sourceStatusDigest).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(assignment.branch).toMatch(/^dsh\/task-[0-9a-f]{24}$/u)
    expect(readFileSync(join(assignment.path, 'tracked.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('base\n')
    writeFileSync(join(assignment.path, 'isolated.txt'), 'task\n')
    expect(existsSync(join(fixture.source, 'isolated.txt'))).toBe(false)
    expect(git(fixture.source, ['status', '--porcelain=v1'])).toBe('')
    expect(await ctx.taskWorktrees.inspect(assignment)).toBe('available')
    await test.dispose()
  })

  it('gives parallel tasks distinct worktrees from the same clean base', async () => {
    const fixture = repository()
    const test = await mount(fixture.home)
    const { ctx } = test
    const [first, second] = await Promise.all([
      ctx.taskWorktrees.create({
        taskId: SessionId('parallel-a'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
      }),
      ctx.taskWorktrees.create({
        taskId: SessionId('parallel-b'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
      }),
    ])

    expect(first.path).not.toBe(second.path)
    expect(first.branch).not.toBe(second.branch)
    expect(first.baseCommit).toBe(second.baseCommit)
    expect(git(fixture.source, ['status', '--porcelain=v1'])).toBe('')
    await test.dispose()
  })

  it('records source dirtiness without copying or modifying it', async () => {
    const fixture = repository()
    writeFileSync(join(fixture.source, 'tracked.txt'), 'dirty source\n')
    writeFileSync(join(fixture.source, 'untracked.txt'), 'private\n')
    const before = git(fixture.source, ['status', '--porcelain=v1', '-z'])
    const test = await mount(fixture.home)
    const { ctx } = test
    const assignment = await ctx.taskWorktrees.create({
      taskId: SessionId('dirty-source'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
    })

    expect(assignment.sourceDirty).toBe(true)
    expect(assignment.sourceStatusDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(readFileSync(join(assignment.path, 'tracked.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('base\n')
    expect(existsSync(join(assignment.path, 'untracked.txt'))).toBe(false)
    expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe(before)
    await test.dispose()
  })

  it('fails before mutation for unsupported or unsafe repositories', async () => {
    const fixture = repository()
    const plain = join(fixture.root, 'plain')
    mkdirSync(plain)
    const unborn = join(fixture.root, 'unborn')
    mkdirSync(unborn)
    git(unborn, ['init'])
    const nested = join(fixture.source, 'nested')
    mkdirSync(nested)
    git(nested, ['init'])
    git(nested, ['config', 'user.name', 'DeepSeek Harness Test'])
    git(nested, ['config', 'user.email', 'test@localhost'])
    writeFileSync(join(nested, 'nested.txt'), 'nested\n')
    git(nested, ['add', 'nested.txt'])
    git(nested, ['commit', '-m', 'nested'])
    const test = await mount(fixture.home)
    const { ctx } = test

    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('plain'), workspaceId: WorkspaceId('workspace'), workspacePath: plain,
    })).rejects.toMatchObject({ code: 'WORKTREE_NOT_GIT' } satisfies Partial<TaskWorktreeError>)
    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('unborn'), workspaceId: WorkspaceId('workspace'), workspacePath: unborn,
    })).rejects.toMatchObject({ code: 'WORKTREE_UNBORN_HEAD' } satisfies Partial<TaskWorktreeError>)
    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('nested'), workspaceId: WorkspaceId('workspace'), workspacePath: nested,
    })).rejects.toMatchObject({ code: 'WORKTREE_NESTED_REPOSITORY' } satisfies Partial<TaskWorktreeError>)

    const constrained = new Context()
    const constrainedSubprocess = await constrained.plugin(LocalSubprocessRuntime)
    const constrainedWorktrees = await constrained.plugin(
      LocalTaskWorktrees,
      { dshHome: fixture.home, minFreeBytes: Number.MAX_SAFE_INTEGER },
    )
    await expect(constrained.taskWorktrees.create({
      taskId: SessionId('no-space'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
    })).rejects.toMatchObject({ code: 'WORKTREE_INSUFFICIENT_SPACE' } satisfies Partial<TaskWorktreeError>)
    expect(git(fixture.source, ['worktree', 'list', '--porcelain'])).not.toContain('dsh/task-')
    await test.dispose()
    await constrainedWorktrees.dispose()
    await constrainedSubprocess.dispose()
  })

  it('preserves an occupied deterministic target and reports later divergence', async () => {
    const fixture = repository()
    const test = await mount(fixture.home)
    const { ctx } = test
    const request = {
      taskId: SessionId('occupied'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
    }
    const assignment = await ctx.taskWorktrees.create(request)
    await expect(ctx.taskWorktrees.create(request)).rejects.toMatchObject({
      code: 'WORKTREE_TARGET_OCCUPIED',
    } satisfies Partial<TaskWorktreeError>)
    expect(readFileSync(join(assignment.path, 'tracked.txt'), 'utf8').replaceAll('\r\n', '\n')).toBe('base\n')

    git(fixture.source, ['worktree', 'remove', '--force', assignment.path])
    expect(await ctx.taskWorktrees.inspect(assignment)).toBe('missing')
    await expect(ctx.taskWorktrees.create(request)).rejects.toMatchObject({
      code: 'WORKTREE_BRANCH_OCCUPIED',
    } satisfies Partial<TaskWorktreeError>)
    mkdirSync(dirname(assignment.path), { recursive: true })
    mkdirSync(assignment.path)
    expect(await ctx.taskWorktrees.inspect(assignment)).toBe('diverged')
    await test.dispose()
  })

  it('preserves a worktree and branch when Git fails after checkout', async () => {
    const fixture = repository()
    const hooks = join(fixture.root, 'hooks')
    mkdirSync(hooks)
    const hook = join(hooks, 'post-checkout')
    writeFileSync(hook, '#!/bin/sh\nexit 23\n')
    chmodSync(hook, 0o755)
    git(fixture.source, ['config', 'core.hooksPath', hooks])
    const test = await mount(fixture.home)

    const failure = await test.ctx.taskWorktrees.create({
      taskId: SessionId('hook-failure'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(TaskWorktreeError)
    if (!(failure instanceof TaskWorktreeError)) throw new Error('expected TaskWorktreeError')
    expect(failure.code).toBe('WORKTREE_GIT_FAILED')
    expect(failure.message).toContain('preserved for recovery')
    const listing = git(fixture.source, ['worktree', 'list', '--porcelain'])
    expect(listing).toContain('branch refs/heads/dsh/task-')
    const createdPath = listing.split(/\r?\n/u)
      .find(line => line.startsWith('worktree ') && line.slice('worktree '.length) !== fixture.source)
      ?.slice('worktree '.length)
    expect(createdPath).toBeDefined()
    expect(existsSync(createdPath!)).toBe(true)
    await test.dispose()
  })
})
