import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskReviewError } from '@deepseek-ai/dsh-task-review'
import { cleanupFixtures, git, mount, repository } from './fixture.ts'

afterEach(() => {
  cleanupFixtures()
})

describe('local Task review snapshots', () => {
  it('summarizes committed, dirty, renamed, deleted, untracked, and binary changes without touching the source', async () => {
    const fixture = repository()
    const sourceHead = git(fixture.source, ['rev-parse', 'HEAD']).trim()
    const sourceStatus = git(fixture.source, ['status', '--porcelain=v1', '-z'])
    const test = await mount(fixture)
    const { assignment, ctx } = test

    writeFileSync(join(assignment.path, 'committed.txt'), 'committed\n')
    git(assignment.path, ['add', 'committed.txt'])
    git(assignment.path, ['commit', '-m', 'task commit'])
    writeFileSync(join(assignment.path, 'tracked.txt'), 'staged\n')
    git(assignment.path, ['add', 'tracked.txt'])
    writeFileSync(join(assignment.path, 'tracked.txt'), 'staged and unstaged\n')
    git(assignment.path, ['mv', 'rename-me.txt', 'renamed.txt'])
    unlinkSync(join(assignment.path, 'delete-me.txt'))
    writeFileSync(join(assignment.path, 'untracked.txt'), 'one\ntwo\n')
    writeFileSync(join(assignment.path, 'binary.bin'), Buffer.from([0, 1, 2, 3]))

    const summary = await ctx.taskReview.summarize({ assignment })
    expect(summary).toMatchObject({
      taskId: assignment.taskId,
      workspaceId: assignment.workspaceId,
      baseCommit: assignment.baseCommit,
      branch: assignment.branch,
      sourceHead,
      sourceDirty: false,
      dirty: true,
      truncated: false,
    })
    expect(summary.revision).toMatch(/^[0-9a-f]{64}$/u)
    expect(summary.headCommit).not.toBe(assignment.baseCommit)
    expect(summary.files.map(file => [file.path, file.previousPath, file.status, file.binary])).toEqual([
      ['binary.bin', undefined, 'untracked', true],
      ['committed.txt', undefined, 'added', false],
      ['delete-me.txt', undefined, 'deleted', false],
      ['renamed.txt', 'rename-me.txt', 'renamed', false],
      ['tracked.txt', undefined, 'modified', false],
      ['untracked.txt', undefined, 'untracked', false],
    ])
    expect(summary.additions).toBeGreaterThanOrEqual(4)
    expect(summary.deletions).toBeGreaterThanOrEqual(2)
    expect(git(fixture.source, ['rev-parse', 'HEAD']).trim()).toBe(sourceHead)
    expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe(sourceStatus)
    expect(existsSync(join(fixture.source, 'committed.txt'))).toBe(false)
    expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('base\n')
    await test.dispose()
  })

  it('returns exact text and explicit binary file diffs for the displayed revision', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), 'changed\n')
    writeFileSync(join(assignment.path, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
    const summary = await ctx.taskReview.summarize({ assignment })

    await expect(ctx.taskReview.diff({
      assignment,
      path: 'tracked.txt',
      expectedRevision: summary.revision,
    })).resolves.toMatchObject({
      revision: summary.revision,
      path: 'tracked.txt',
      binary: false,
      truncated: false,
      patch: expect.stringContaining('+changed'),
    })
    await expect(ctx.taskReview.diff({
      assignment,
      path: 'binary.bin',
      expectedRevision: summary.revision,
    })).resolves.toMatchObject({
      revision: summary.revision,
      path: 'binary.bin',
      binary: true,
      truncated: false,
    })
    await test.dispose()
  })

  it('reports an empty review and rejects arbitrary or stale file requests', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    const empty = await ctx.taskReview.summarize({ assignment })
    expect(empty).toMatchObject({ dirty: false, truncated: false, files: [], additions: 0, deletions: 0 })

    await expect(ctx.taskReview.diff({
      assignment,
      path: '../source/tracked.txt',
      expectedRevision: empty.revision,
    })).rejects.toMatchObject({ code: 'REVIEW_INVALID_PATH' } satisfies Partial<TaskReviewError>)
    await expect(ctx.taskReview.diff({
      assignment,
      path: 'tracked.txt',
      expectedRevision: empty.revision,
    })).rejects.toMatchObject({ code: 'REVIEW_FILE_NOT_FOUND' } satisfies Partial<TaskReviewError>)

    writeFileSync(join(assignment.path, 'new.txt'), 'new\n')
    await expect(ctx.taskReview.diff({
      assignment,
      path: 'new.txt',
      expectedRevision: empty.revision,
    })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
    await test.dispose()
  })

  it('rejects missing and diverged recorded worktrees', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    git(fixture.source, ['worktree', 'remove', '--force', assignment.path])
    await expect(ctx.taskReview.summarize({ assignment })).rejects.toMatchObject({
      code: 'REVIEW_WORKTREE_UNAVAILABLE',
    } satisfies Partial<TaskReviewError>)

    mkdirSync(assignment.path, { recursive: true })
    await expect(ctx.taskReview.summarize({ assignment })).rejects.toMatchObject({
      code: 'REVIEW_WORKTREE_DIVERGED',
    } satisfies Partial<TaskReviewError>)
    await test.dispose()
  })

  it('marks a bounded patch as truncated without returning partial repository state', async () => {
    const fixture = repository()
    const test = await mount(fixture, { maxDiffBytes: 80 })
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), `${'changed line\n'.repeat(100)}`)
    const summary = await ctx.taskReview.summarize({ assignment })
    const diff = await ctx.taskReview.diff({
      assignment,
      path: 'tracked.txt',
      expectedRevision: summary.revision,
    })
    expect(diff.truncated).toBe(true)
    expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(80)
    await test.dispose()
  })

  it('propagates cancellation and maps Git startup failure', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const controller = new AbortController()
    controller.abort()
    await expect(test.ctx.taskReview.summarize({ assignment: test.assignment }, controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    await test.dispose()

    const broken = await mount(repository(), { gitCommand: 'definitely-missing-git-command' })
    await expect(broken.ctx.taskReview.summarize({ assignment: broken.assignment })).rejects.toMatchObject({
      code: 'REVIEW_GIT_FAILED',
    } satisfies Partial<TaskReviewError>)
    await broken.dispose()
  })
})
