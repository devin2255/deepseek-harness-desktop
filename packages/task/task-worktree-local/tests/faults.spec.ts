import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LocalTaskWorktrees from '../src/index.ts'
import { removeFixtureSafely } from '../../../../scripts/test-fixture-cleanup.ts'

const fault = vi.hoisted(() => ({ mode: 'none' as 'none' | 'target' | 'inspection' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    lstat: async (path: string) => {
      if (fault.mode === 'target' && path.includes('worktrees')) {
        throw Object.assign(new Error('scripted target access failure'), { code: 'EACCES' })
      }
      if (fault.mode === 'inspection' && path.endsWith('owned')) {
        throw Object.assign(new Error('scripted inspection access failure'), { code: 'EACCES' })
      }
      return original.lstat(path)
    },
  }
})

const fixtures: string[] = []
afterEach(() => {
  fault.mode = 'none'
  for (const root of fixtures.splice(0)) removeFixtureSafely(root)
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-worktree-fault-'))
  fixtures.push(root)
  const source = join(root, 'source')
  const home = join(root, 'home')
  const owned = join(root, 'owned')
  for (const path of [source, home, owned]) mkdirSync(path)
  return { root, source, home, owned }
}

async function mount(home: string, source: string, head = 'a'.repeat(40), worktreeList = '') {
  const ctx = new Context()
  const spawn = vi.fn(({ cwd, argv }: { cwd: string; argv: readonly string[] }) => {
    const args = argv.slice(3)
    let stdout = ''
    let exitCode = 0
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      if (cwd === source) stdout = `${source}\n`
      else exitCode = 128
    } else if (args[0] === 'rev-parse' && args[1] === '--verify') {
      stdout = `${head}\n`
    } else if (args[0] === 'show-ref') {
      exitCode = 1
    } else if (args[0] === 'worktree' && args[1] === 'list') {
      stdout = worktreeList
    }
    return {
      done: Promise.resolve({ exitCode, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false }) },
      },
    }
  })
  ctx.provide('subprocess', { resolveExecutable: async () => 'git', spawn } as never)
  const fiber = await ctx.plugin(LocalTaskWorktrees, { dshHome: home, minFreeBytes: 0 })
  return { ctx, fiber, spawn }
}

function assignment(sourcePath: string, path: string): TaskWorktreeAssignment {
  return {
    kind: 'git-worktree', taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'),
    sourcePath, path, branch: 'dsh/task-0123456789abcdef01234567',
    baseCommit: 'a'.repeat(40), sourceHead: 'a'.repeat(40), sourceDirty: false,
    sourceStatusDigest: 'b'.repeat(64), createdAt: 1,
  }
}

describe('local Task worktree filesystem and Git faults', () => {
  it('rejects a malformed Git HEAD before trying to create a branch', async () => {
    const paths = fixture()
    const test = await mount(paths.home, paths.source, 'invalid-head')
    try {
      await expect(test.ctx.taskWorktrees.create({
        taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'), workspacePath: paths.source,
      })).rejects.toMatchObject({ code: 'WORKTREE_GIT_FAILED', message: 'Git returned an invalid HEAD commit.' })
      expect(test.spawn.mock.calls.some(([spec]) => spec.argv.includes('add'))).toBe(false)
    } finally {
      await test.fiber.dispose()
    }
  })

  it('does not mistake an inaccessible managed target for an absent one', async () => {
    const paths = fixture()
    const test = await mount(paths.home, paths.source)
    fault.mode = 'target'
    try {
      await expect(test.ctx.taskWorktrees.create({
        taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'), workspacePath: paths.source,
      })).rejects.toMatchObject({ code: 'EACCES' })
    } finally {
      await test.fiber.dispose()
    }
  })

  it('classifies an inaccessible owned path as diverged and skips vanished Git records', async () => {
    const paths = fixture()
    const vanished = join(paths.root, 'vanished')
    const list = `worktree ${vanished}\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0`
    const test = await mount(paths.home, paths.source, 'a'.repeat(40), list)
    const owned = assignment(paths.source, paths.owned)
    try {
      fault.mode = 'inspection'
      await expect(test.ctx.taskWorktrees.inspect(owned)).resolves.toBe('diverged')
      fault.mode = 'none'
      await expect(test.ctx.taskWorktrees.inspect(owned)).resolves.toBe('diverged')
      expect(test.spawn.mock.calls.some(([spec]) => spec.argv.includes('list'))).toBe(true)
    } finally {
      await test.fiber.dispose()
    }
  })
})
