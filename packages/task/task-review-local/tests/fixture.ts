import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalTaskReview from '@deepseek-ai/dsh-task-review-local'
import LocalTaskWorktrees from '@deepseek-ai/dsh-task-worktree-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { removeFixtureSafely } from '../../../../scripts/test-fixture-cleanup.ts'

const fixtures: string[] = []

/** Execute test Git with stable checkout line endings. */
export function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Paths owned by one disposable Git fixture. */
export interface ReviewRepositoryFixture {
  readonly root: string
  readonly source: string
  readonly home: string
}

/** Create a committed repository suitable for Task worktree tests. */
export function repository(): ReviewRepositoryFixture {
  const root = mkdtempSync(join(tmpdir(), 'dsh-task-review-'))
  fixtures.push(root)
  const source = join(root, 'source')
  const home = join(root, 'home')
  mkdirSync(source)
  mkdirSync(home)
  git(source, ['init'])
  git(source, ['config', 'core.autocrlf', 'false'])
  git(source, ['config', 'user.name', 'DeepSeek Harness Test'])
  git(source, ['config', 'user.email', 'test@localhost'])
  writeFileSync(join(source, 'tracked.txt'), 'base\n')
  writeFileSync(join(source, 'rename-me.txt'), 'rename\n')
  writeFileSync(join(source, 'delete-me.txt'), 'delete\n')
  git(source, ['add', '.'])
  git(source, ['commit', '-m', 'base'])
  return { root, source: resolve(source), home: resolve(home) }
}

/** Mount managed subprocess, Task worktree, and local review Providers. */
export async function mount(
  fixture: ReviewRepositoryFixture,
  reviewConfig: Record<string, unknown> = {},
) {
  const ctx = new Context()
  const subprocess = await ctx.plugin(LocalSubprocessRuntime)
  const worktrees = await ctx.plugin(LocalTaskWorktrees, { dshHome: fixture.home })
  const assignment = await ctx.taskWorktrees.create({
    taskId: SessionId('review-task'),
    workspaceId: WorkspaceId('review-workspace'),
    workspacePath: fixture.source,
  })
  const review = await ctx.plugin(LocalTaskReview, reviewConfig)
  return {
    assignment,
    ctx,
    async dispose(): Promise<void> {
      await review.dispose()
      await worktrees.dispose()
      await subprocess.dispose()
    },
  }
}

/** Remove all disposable review repositories created by this worker. */
export function cleanupFixtures(): void {
  for (const root of fixtures.splice(0)) removeFixtureSafely(root)
}
