import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { TaskWorktreeError } from '@deepseek-ai/dsh-task-worktree'
import LocalTaskWorktrees, { resolveConfig } from '@deepseek-ai/dsh-task-worktree-local'
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
  return { root, source: realpathSync(source), home: realpathSync(home) }
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
  it('resolves explicit and omitted Git limits and rejects an invalid executable', () => {
    const defaults = resolveConfig({})
    expect(defaults.gitCommand).toBe('git')
    expect(defaults.minFreeBytes).toBeGreaterThan(0)
    expect(defaults.commandTimeoutMs).toBeGreaterThan(0)
    expect(defaults.terminateGraceMs).toBeGreaterThan(0)
    expect(defaults.maxOutputBytes).toBeGreaterThan(0)
    expect(resolveConfig({
      gitCommand: 'git-custom', minFreeBytes: 0, commandTimeoutMs: 10,
      terminateGraceMs: 20, maxOutputBytes: 30,
    })).toMatchObject({
      gitCommand: 'git-custom', minFreeBytes: 0, commandTimeoutMs: 10,
      terminateGraceMs: 20, maxOutputBytes: 30,
    })
    expect(() => resolveConfig({ gitCommand: ' git ' })).toThrow('gitCommand must be non-empty and normalized')
  })

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
      sourcePath: await realpath(fixture.source),
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
    expect(await ctx.taskWorktrees.inspect({ ...assignment, baseCommit: '0'.repeat(40) })).toBe('diverged')
    await expect(ctx.taskWorktrees.inspect({ ...assignment, sourcePath: fixture.home }))
      .rejects.toMatchObject({ code: 'WORKTREE_GIT_FAILED' } satisfies Partial<TaskWorktreeError>)
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
    const file = join(fixture.root, 'not-a-directory')
    writeFileSync(file, 'plain')
    const childDirectory = join(fixture.source, 'child-directory')
    mkdirSync(childDirectory)
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
    const submoduleOrigin = repository()
    git(fixture.source, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleOrigin.source, 'module'])
    const submodule = join(fixture.source, 'module')
    const test = await mount(fixture.home)
    const { ctx } = test

    for (const workspacePath of [join(fixture.root, 'missing'), file, childDirectory]) {
      await expect(ctx.taskWorktrees.create({
        taskId: SessionId(`invalid-${workspacePath}`), workspaceId: WorkspaceId('workspace'), workspacePath,
      })).rejects.toMatchObject({ code: 'WORKTREE_NOT_GIT' } satisfies Partial<TaskWorktreeError>)
    }

    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('plain'), workspaceId: WorkspaceId('workspace'), workspacePath: plain,
    })).rejects.toMatchObject({ code: 'WORKTREE_NOT_GIT' } satisfies Partial<TaskWorktreeError>)
    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('unborn'), workspaceId: WorkspaceId('workspace'), workspacePath: unborn,
    })).rejects.toMatchObject({ code: 'WORKTREE_UNBORN_HEAD' } satisfies Partial<TaskWorktreeError>)
    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('nested'), workspaceId: WorkspaceId('workspace'), workspacePath: nested,
    })).rejects.toMatchObject({ code: 'WORKTREE_NESTED_REPOSITORY' } satisfies Partial<TaskWorktreeError>)
    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('submodule'), workspaceId: WorkspaceId('workspace'), workspacePath: submodule,
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

  it('reports an unavailable Git executable and can retry its resolution', async () => {
    const fixture = repository()
    const test = await mount(fixture.home, { gitCommand: 'missing-deepseek-test-git' })
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(test.ctx.taskWorktrees.create({
          taskId: SessionId('no-git'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
        })).rejects.toMatchObject({ code: 'WORKTREE_UNAVAILABLE' } satisfies Partial<TaskWorktreeError>)
      }
    } finally {
      await test.dispose()
    }
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
    expect(await ctx.taskWorktrees.inspect({ ...assignment, sourcePath: join(fixture.root, 'missing') })).toBe('diverged')

    git(fixture.source, ['worktree', 'remove', '--force', assignment.path])
    expect(await ctx.taskWorktrees.inspect(assignment)).toBe('missing')
    expect(await ctx.taskWorktrees.inspect({ ...assignment, path: join(fixture.source, 'tracked.txt') })).toBe('diverged')
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

  it('retains a generic failure when the Git add subprocess terminates', async () => {
    const fixture = repository()
    const test = await mount(fixture.home)
    const spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
    const intercepted = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('worktree') && spec.argv.includes('add')) {
        return {
          done: Promise.resolve({ exitCode: null, signal: 'SIGTERM' }),
          collected: {},
        } as ReturnType<typeof test.ctx.subprocess.spawn>
      }
      return spawn(spec)
    })
    try {
      const failure = test.ctx.taskWorktrees.create({
        taskId: SessionId('terminated-add'), workspaceId: WorkspaceId('workspace'), workspacePath: fixture.source,
      })
      await expect(failure).rejects.toMatchObject({ code: 'WORKTREE_GIT_FAILED' } satisfies Partial<TaskWorktreeError>)
      await expect(failure).rejects.toThrow('Git could not create the worktree. Any partial directory or branch was preserved for recovery.')
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })
})
