import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskReviewError } from '@deepseek-ai/dsh-task-review'
import { cleanupFixtures, mount, repository } from './fixture.ts'

afterEach(() => { cleanupFixtures() })

describe('Task review Git identity faults', () => {
  it('rejects vanished registrations, malformed HEADs, and lost base ancestry', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    let mode: 'vanished' | 'worktree-head' | 'source-head' | 'ancestry' = 'vanished'
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      let stdout: string | undefined
      let exitCode = 0
      if (mode === 'vanished' && spec.argv.includes('worktree') && spec.argv.includes('list')) {
        stdout = `worktree ${join(fixture.root, 'vanished')}\0HEAD ${assignment.baseCommit}\0branch refs/heads/${assignment.branch}\0\0`
      }
      if (spec.argv.includes('rev-parse') && spec.argv.includes('--verify')) {
        if (mode === 'worktree-head' && spec.cwd === assignment.path) stdout = 'not-a-commit\n'
        if (mode === 'source-head' && spec.cwd === assignment.sourcePath) stdout = 'not-a-commit\n'
      }
      if (mode === 'ancestry' && spec.argv.includes('merge-base')) {
        stdout = ''
        exitCode = 1
      }
      if (stdout !== undefined) {
        return {
          done: Promise.resolve({ exitCode, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        } as unknown as ReturnType<typeof ctx.subprocess.spawn>
      }
      return spawn(spec)
    })
    try {
      for (const [fault, code] of [
        ['vanished', 'REVIEW_WORKTREE_DIVERGED'],
        ['worktree-head', 'REVIEW_GIT_FAILED'],
        ['source-head', 'REVIEW_GIT_FAILED'],
        ['ancestry', 'REVIEW_WORKTREE_DIVERGED'],
      ] as const) {
        mode = fault
        await expect(ctx.taskReview.summarize({ assignment }))
          .rejects.toMatchObject({ code } satisfies Partial<TaskReviewError>)
      }
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })

  it('preserves caller cancellation and an already classified Git failure', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const abort = new AbortController()
    const cancelled = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('worktree') && spec.argv.includes('list')) {
        abort.abort()
        throw new Error('cancelled during Git')
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.summarize({ assignment }, abort.signal))
        .rejects.toThrow('cancelled during Git')
    } finally {
      cancelled.mockRestore()
    }

    const classified = new TaskReviewError('already classified', 'REVIEW_GIT_FAILED')
    const failed = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('worktree') && spec.argv.includes('list')) throw classified
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.summarize({ assignment })).rejects.toBe(classified)
    } finally {
      failed.mockRestore()
      await test.dispose()
    }
  })

  it('serializes overlapping delivery attempts and releases both queue entries', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      const reviewed = await ctx.taskReview.summarize({ assignment })
      const request = { assignment, expectedRevision: reviewed.revision, message: ' ' }
      const outcomes = await Promise.allSettled([
        ctx.taskReview.commit(request),
        ctx.taskReview.commit(request),
      ])
      expect(outcomes).toMatchObject([
        { status: 'rejected', reason: { code: 'REVIEW_INVALID_MESSAGE' } },
        { status: 'rejected', reason: { code: 'REVIEW_INVALID_MESSAGE' } },
      ])
    } finally {
      await test.dispose()
    }
  })
})
