import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import LocalTaskReview from '@deepseek-ai/dsh-task-review-local'
import { TaskReviewOperationId, type TaskDeliveryIntent } from '@deepseek-ai/dsh-task-review'
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
  return { root, source: realpathSync(source), home: realpathSync(home) }
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

/** Capture real Provider authorization, optionally stopping before user-repository mutation. */
export async function authorizeDelivery(
  test: Awaited<ReturnType<typeof mount>>, kind: TaskDeliveryIntent['kind'], complete: boolean, edit = true,
): Promise<TaskDeliveryIntent> {
  const { ctx, assignment } = test
  if (edit) {
    writeFileSync(join(assignment.path, 'tracked.txt'), 'authorized edit\n')
    writeFileSync(join(assignment.path, 'new.txt'), 'new content\n')
  }
  let summary = await ctx.taskReview.summarize({ assignment })
  if (kind === 'apply') {
    await ctx.taskReview.commit({ assignment, expectedRevision: summary.revision, message: 'Prepare Apply' })
    summary = await ctx.taskReview.summarize({ assignment })
  }
  const operationId = TaskReviewOperationId('00000000-0000-4000-8000-000000000009')
  let intent: TaskDeliveryIntent | undefined
  const capture = (value: TaskDeliveryIntent): Promise<void> => {
    intent = value
    return complete ? Promise.resolve() : Promise.reject(new Error('Stop after durable authorization'))
  }
  const operation = kind === 'commit'
    ? ctx.taskReview.commit({ assignment, expectedRevision: summary.revision, message: 'Authorized Commit',
      authorization: { operationId, authorize: preflight => capture({ kind, operationId, reviewRevision: summary.revision,
        message: 'Authorized Commit', ...preflight }) } })
    : kind === 'apply'
      ? ctx.taskReview.apply({ assignment, expectedRevision: summary.revision, commit: summary.headCommit,
        expectedSourceHead: summary.sourceHead,
        authorization: { operationId, authorize: () => capture({ kind, operationId, reviewRevision: summary.revision,
          commit: summary.headCommit, sourceHead: summary.sourceHead }) } })
      : ctx.taskReview.discard({ assignment, expectedRevision: summary.revision, confirmedUncommittedLoss: true,
        authorization: { operationId, authorize: preflight => capture({ kind, operationId, reviewRevision: summary.revision,
          confirmedUncommittedLoss: true, ...preflight }) } })
  if (complete) await operation
  else {
    const error = await operation.then(() => undefined, (cause: unknown) => cause)
    if (!(error instanceof Error) || error.message !== 'Stop after durable authorization') throw error
  }
  if (intent === undefined) throw new Error('No authorization captured')
  return intent
}
