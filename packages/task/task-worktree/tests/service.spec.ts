import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import {
  TaskWorktreeError,
  TaskWorktreeService,
} from '@deepseek-ai/dsh-task-worktree'
import type {
  CreateTaskWorktreeRequest,
  TaskWorktreeAssignment,
  TaskWorktreeErrorCode,
} from '@deepseek-ai/dsh-task-worktree'

const assignment: TaskWorktreeAssignment = {
  kind: 'git-worktree',
  taskId: SessionId('task-1'),
  workspaceId: WorkspaceId('workspace-1'),
  sourcePath: '/code/project',
  path: '/data/worktrees/project/task',
  branch: 'dsh/task-deadbeef',
  baseCommit: 'a'.repeat(40),
  sourceHead: 'a'.repeat(40),
  sourceDirty: false,
  sourceStatusDigest: 'b'.repeat(64),
  createdAt: 10,
}

class StubTaskWorktrees extends TaskWorktreeService {
  async create(request: CreateTaskWorktreeRequest): Promise<TaskWorktreeAssignment> {
    expect(request).toEqual({
      taskId: SessionId('task-1'),
      workspaceId: WorkspaceId('workspace-1'),
      workspacePath: '/code/project',
    })
    return assignment
  }

  async inspect(value: TaskWorktreeAssignment): Promise<'available' | 'missing' | 'diverged'> {
    return value === assignment ? 'available' : 'diverged'
  }
}

describe('TaskWorktree Service Definition', () => {
  it('registers one provider and releases it on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubTaskWorktrees)
    await expect(ctx.taskWorktrees.create({
      taskId: SessionId('task-1'),
      workspaceId: WorkspaceId('workspace-1'),
      workspacePath: '/code/project',
    })).resolves.toBe(assignment)
    await expect(ctx.taskWorktrees.inspect(assignment)).resolves.toBe('available')
    await expect(ctx.plugin(StubTaskWorktrees)).rejects.toThrow()
    await fiber.dispose()
    expect((ctx as Context & { taskWorktrees?: unknown }).taskWorktrees).toBeUndefined()
  })

  it('exposes stable machine-routable failures', () => {
    const codes = [
      'WORKTREE_NOT_GIT',
      'WORKTREE_NESTED_REPOSITORY',
      'WORKTREE_UNBORN_HEAD',
      'WORKTREE_INSUFFICIENT_SPACE',
      'WORKTREE_TARGET_OCCUPIED',
      'WORKTREE_BRANCH_OCCUPIED',
      'WORKTREE_GIT_FAILED',
      'WORKTREE_UNAVAILABLE',
    ] as const satisfies readonly TaskWorktreeErrorCode[]
    const cause = new Error('git failed')
    for (const code of codes) {
      expect(new TaskWorktreeError('cannot create worktree', code, { cause })).toMatchObject({
        name: 'TaskWorktreeError',
        code,
        cause,
      })
    }
  })

  it('publishes the complete durable assignment vocabulary', () => {
    expectTypeOf<TaskWorktreeAssignment>().toExtend<{
      readonly kind: 'git-worktree'
      readonly taskId: ReturnType<typeof SessionId>
      readonly workspaceId: ReturnType<typeof WorkspaceId>
      readonly sourcePath: string
      readonly path: string
      readonly branch: string
      readonly baseCommit: string
      readonly sourceHead: string
      readonly sourceDirty: boolean
      readonly sourceStatusDigest: string
      readonly createdAt: number
    }>()
    expect(assignment.kind).toBe('git-worktree')
  })
})
