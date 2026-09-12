import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  TaskReviewError,
  TaskReviewOperationId,
  TaskReviewRevision,
  TaskReviewService,
} from '@deepseek-ai/dsh-task-review'
import type {
  ApplyTaskReviewRequest,
  CommitTaskReviewRequest,
  DiscardTaskReviewRequest,
  GetTaskFileDiffRequest,
  SummarizeTaskReviewRequest,
  TaskApplyReceipt,
  TaskCommitReceipt,
  TaskDiscardReceipt,
  TaskFileDiff,
  TaskReviewErrorCode,
  TaskReviewFile,
  TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const taskId = SessionId('task-1')
const workspaceId = WorkspaceId('workspace-1')
const revision = TaskReviewRevision('review-1')
const operationId = TaskReviewOperationId('operation-1')
const assignment: TaskWorktreeAssignment = {
  kind: 'git-worktree',
  taskId,
  workspaceId,
  sourcePath: '/code/project',
  path: '/data/worktrees/project/task',
  branch: 'dsh/task-deadbeef',
  baseCommit: 'a'.repeat(40),
  sourceHead: 'a'.repeat(40),
  sourceDirty: false,
  sourceStatusDigest: 'b'.repeat(64),
  createdAt: 10,
}
const file: TaskReviewFile = {
  path: 'src/index.ts',
  status: 'modified',
  binary: false,
  additions: 2,
  deletions: 1,
}
const summary: TaskReviewSummary = {
  taskId,
  workspaceId,
  revision,
  baseCommit: assignment.baseCommit,
  headCommit: assignment.baseCommit,
  branch: assignment.branch,
  dirty: true,
  truncated: false,
  files: [file],
  additions: 2,
  deletions: 1,
}
const diff: TaskFileDiff = {
  taskId,
  workspaceId,
  revision,
  path: file.path,
  binary: false,
  truncated: false,
  patch: '@@ -1 +1,2 @@',
}
const commitReceipt: TaskCommitReceipt = {
  kind: 'commit',
  operationId,
  taskId,
  workspaceId,
  reviewRevision: revision,
  branch: assignment.branch,
  commit: 'c'.repeat(40),
  committedAt: 20,
}
const applyReceipt: TaskApplyReceipt = {
  kind: 'apply',
  operationId,
  taskId,
  workspaceId,
  reviewRevision: revision,
  commit: commitReceipt.commit,
  sourceHead: assignment.sourceHead,
  appliedAt: 30,
}
const discardReceipt: TaskDiscardReceipt = {
  kind: 'discard',
  operationId,
  taskId,
  workspaceId,
  reviewRevision: revision,
  branch: assignment.branch,
  branchPreserved: true,
  worktreeRemoved: true,
  discardedAt: 40,
}

class StubTaskReview extends TaskReviewService {
  async summarize(request: SummarizeTaskReviewRequest): Promise<TaskReviewSummary> {
    expect(request.assignment).toBe(assignment)
    return summary
  }

  async diff(request: GetTaskFileDiffRequest): Promise<TaskFileDiff> {
    expect(request).toEqual({ assignment, path: file.path, expectedRevision: revision })
    return diff
  }

  async commit(request: CommitTaskReviewRequest): Promise<TaskCommitReceipt> {
    expect(request).toEqual({ assignment, expectedRevision: revision, message: 'Ship review' })
    return commitReceipt
  }

  async apply(request: ApplyTaskReviewRequest): Promise<TaskApplyReceipt> {
    expect(request).toEqual({ assignment, expectedRevision: revision, commit: commitReceipt.commit })
    return applyReceipt
  }

  async discard(request: DiscardTaskReviewRequest): Promise<TaskDiscardReceipt> {
    expect(request).toEqual({ assignment, expectedRevision: revision, confirmedUncommittedLoss: true })
    return discardReceipt
  }
}

describe('TaskReview Service Definition', () => {
  it('registers one provider and releases it on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubTaskReview)
    await expect(ctx.taskReview.summarize({ assignment })).resolves.toBe(summary)
    await expect(ctx.taskReview.diff({ assignment, path: file.path, expectedRevision: revision })).resolves.toBe(diff)
    await expect(ctx.taskReview.commit({
      assignment,
      expectedRevision: revision,
      message: 'Ship review',
    })).resolves.toBe(commitReceipt)
    await expect(ctx.taskReview.apply({
      assignment,
      expectedRevision: revision,
      commit: commitReceipt.commit,
    })).resolves.toBe(applyReceipt)
    await expect(ctx.taskReview.discard({
      assignment,
      expectedRevision: revision,
      confirmedUncommittedLoss: true,
    })).resolves.toBe(discardReceipt)
    await expect(ctx.plugin(StubTaskReview)).rejects.toThrow()
    await fiber.dispose()
    expect((ctx as Context & { taskReview?: unknown }).taskReview).toBeUndefined()
  })

  it('exposes stable machine-routable failures', () => {
    const codes = [
      'REVIEW_WORKTREE_UNAVAILABLE',
      'REVIEW_WORKTREE_DIVERGED',
      'REVIEW_STALE',
      'REVIEW_INVALID_PATH',
      'REVIEW_FILE_NOT_FOUND',
      'REVIEW_EMPTY',
      'REVIEW_IDENTITY_MISSING',
      'REVIEW_SOURCE_DIRTY',
      'REVIEW_SOURCE_MOVED',
      'REVIEW_APPLY_CONFLICT',
      'REVIEW_CONFIRMATION_REQUIRED',
      'REVIEW_GIT_FAILED',
    ] as const satisfies readonly TaskReviewErrorCode[]
    const cause = new Error('git failed')
    for (const code of codes) {
      expect(new TaskReviewError('cannot deliver review', code, { cause })).toMatchObject({
        name: 'TaskReviewError',
        code,
        cause,
      })
    }
  })

  it('publishes immutable review and receipt values', () => {
    expectTypeOf<TaskReviewFile['status']>().toEqualTypeOf<
      'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'untracked' | 'conflicted'
    >()
    expectTypeOf(summary.files).toEqualTypeOf<readonly TaskReviewFile[]>()
    expectTypeOf(diff.binary).toEqualTypeOf<boolean>()
    expectTypeOf(diff.truncated).toEqualTypeOf<boolean>()
    expectTypeOf(commitReceipt.kind).toEqualTypeOf<'commit'>()
    expectTypeOf(applyReceipt.kind).toEqualTypeOf<'apply'>()
    expectTypeOf(discardReceipt.kind).toEqualTypeOf<'discard'>()
    expect(TaskReviewRevision('review-2')).toBe('review-2')
    expect(TaskReviewOperationId('operation-2')).toBe('operation-2')
  })
})
