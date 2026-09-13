import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskReviewError } from '@deepseek-ai/dsh-task-review'
import { cleanupFixtures, git, mount, repository } from './fixture.ts'

afterEach(() => {
  cleanupFixtures()
})

describe('local Task review delivery', () => {
  it('commits the exact reviewed state on the Task branch without changing the source', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    const sourceHead = git(fixture.source, ['rev-parse', 'HEAD']).trim()
    writeFileSync(join(assignment.path, 'tracked.txt'), 'task change\n')
    writeFileSync(join(assignment.path, 'new.txt'), 'new\n')
    const reviewed = await ctx.taskReview.summarize({ assignment })

    const receipt = await ctx.taskReview.commit({
      assignment,
      expectedRevision: reviewed.revision,
      message: 'Implement reviewed change',
    })

    expect(receipt).toMatchObject({
      kind: 'commit',
      taskId: assignment.taskId,
      workspaceId: assignment.workspaceId,
      reviewRevision: reviewed.revision,
      branch: assignment.branch,
    })
    expect(receipt.operationId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/u)
    expect(receipt.committedRevision).toMatch(/^[0-9a-f]{64}$/u)
    expect(git(assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(receipt.commit)
    expect(git(assignment.path, ['status', '--porcelain=v1', '-z'])).toBe('')
    expect(git(assignment.path, ['show', '--format=%s', '--no-patch', 'HEAD']).trim())
      .toBe('Implement reviewed change')
    expect(git(fixture.source, ['rev-parse', 'HEAD']).trim()).toBe(sourceHead)
    expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe('')
    expect(existsSync(join(fixture.source, 'new.txt'))).toBe(false)
    await expect(ctx.taskReview.summarize({ assignment })).resolves.toMatchObject({
      revision: receipt.committedRevision,
      headCommit: receipt.commit,
    })
    await test.dispose()
  })

  it('rejects empty, stale, unidentified, and failed commits without moving Task HEAD', async () => {
    const emptyFixture = repository()
    const empty = await mount(emptyFixture)
    const emptyReview = await empty.ctx.taskReview.summarize({ assignment: empty.assignment })
    await expect(empty.ctx.taskReview.commit({
      assignment: empty.assignment,
      expectedRevision: emptyReview.revision,
      message: '   ',
    })).rejects.toMatchObject({ code: 'REVIEW_INVALID_MESSAGE' } satisfies Partial<TaskReviewError>)
    await expect(empty.ctx.taskReview.commit({
      assignment: empty.assignment,
      expectedRevision: emptyReview.revision,
      message: 'Nothing',
    })).rejects.toMatchObject({ code: 'REVIEW_EMPTY' } satisfies Partial<TaskReviewError>)
    await empty.dispose()

    const staleFixture = repository()
    const stale = await mount(staleFixture)
    writeFileSync(join(stale.assignment.path, 'tracked.txt'), 'first\n')
    const staleReview = await stale.ctx.taskReview.summarize({ assignment: stale.assignment })
    writeFileSync(join(stale.assignment.path, 'tracked.txt'), 'second\n')
    await expect(stale.ctx.taskReview.commit({
      assignment: stale.assignment,
      expectedRevision: staleReview.revision,
      message: 'Stale',
    })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
    await stale.dispose()

    const identityFixture = repository()
    const identity = await mount(identityFixture)
    writeFileSync(join(identity.assignment.path, 'tracked.txt'), 'identity\n')
    git(identity.assignment.path, ['config', 'user.name', ''])
    git(identity.assignment.path, ['config', 'user.email', ''])
    const identityReview = await identity.ctx.taskReview.summarize({ assignment: identity.assignment })
    await expect(identity.ctx.taskReview.commit({
      assignment: identity.assignment,
      expectedRevision: identityReview.revision,
      message: 'Identity',
    })).rejects.toMatchObject({ code: 'REVIEW_IDENTITY_MISSING' } satisfies Partial<TaskReviewError>)
    expect(git(identity.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(identity.assignment.baseCommit)
    await identity.dispose()

    const hookFixture = repository()
    const hook = await mount(hookFixture)
    const hooks = join(hookFixture.root, 'hooks')
    mkdirSync(hooks)
    const preCommit = join(hooks, 'pre-commit')
    writeFileSync(preCommit, '#!/bin/sh\nexit 23\n')
    chmodSync(preCommit, 0o755)
    git(hook.assignment.path, ['config', 'core.hooksPath', hooks])
    writeFileSync(join(hook.assignment.path, 'tracked.txt'), 'hook\n')
    const hookReview = await hook.ctx.taskReview.summarize({ assignment: hook.assignment })
    await expect(hook.ctx.taskReview.commit({
      assignment: hook.assignment,
      expectedRevision: hookReview.revision,
      message: 'Hook fails',
    })).rejects.toMatchObject({ code: 'REVIEW_GIT_FAILED' } satisfies Partial<TaskReviewError>)
    expect(git(hook.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(hook.assignment.baseCommit)
    await hook.dispose()
  })

  it('preflights and applies one committed Task patch to a clean source index', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), 'applied task change\n')
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const committed = await ctx.taskReview.commit({
      assignment,
      expectedRevision: reviewed.revision,
      message: 'Apply me',
    })
    const ready = await ctx.taskReview.summarize({ assignment })

    const receipt = await ctx.taskReview.apply({
      assignment,
      expectedRevision: ready.revision,
      expectedSourceHead: ready.sourceHead,
      commit: committed.commit,
    })

    expect(receipt).toMatchObject({
      kind: 'apply',
      taskId: assignment.taskId,
      workspaceId: assignment.workspaceId,
      reviewRevision: ready.revision,
      commit: committed.commit,
      sourceHeadBefore: ready.sourceHead,
      sourceHeadAfter: ready.sourceHead,
    })
    expect(receipt.operationId).toMatch(/^[0-9a-f-]{36}$/u)
    expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('applied task change\n')
    expect(git(fixture.source, ['diff', '--cached', '--name-only']).trim()).toBe('tracked.txt')
    expect(git(fixture.source, ['rev-parse', 'HEAD']).trim()).toBe(ready.sourceHead)
    await test.dispose()
  })

  it('rejects dirty or moved source state and leaves a conflicting preflight untouched', async () => {
    const dirtyFixture = repository()
    const dirty = await mount(dirtyFixture)
    writeFileSync(join(dirty.assignment.path, 'tracked.txt'), 'task\n')
    let reviewed = await dirty.ctx.taskReview.summarize({ assignment: dirty.assignment })
    const committed = await dirty.ctx.taskReview.commit({
      assignment: dirty.assignment,
      expectedRevision: reviewed.revision,
      message: 'Task',
    })
    reviewed = await dirty.ctx.taskReview.summarize({ assignment: dirty.assignment })
    writeFileSync(join(dirtyFixture.source, 'tracked.txt'), 'dirty source\n')
    await expect(dirty.ctx.taskReview.apply({
      assignment: dirty.assignment,
      expectedRevision: reviewed.revision,
      expectedSourceHead: reviewed.sourceHead,
      commit: committed.commit,
    })).rejects.toMatchObject({ code: 'REVIEW_SOURCE_DIRTY' } satisfies Partial<TaskReviewError>)
    await dirty.dispose()

    const movedFixture = repository()
    const moved = await mount(movedFixture)
    writeFileSync(join(moved.assignment.path, 'tracked.txt'), 'task\n')
    let movedReview = await moved.ctx.taskReview.summarize({ assignment: moved.assignment })
    const movedCommit = await moved.ctx.taskReview.commit({
      assignment: moved.assignment,
      expectedRevision: movedReview.revision,
      message: 'Task',
    })
    movedReview = await moved.ctx.taskReview.summarize({ assignment: moved.assignment })
    writeFileSync(join(movedFixture.source, 'source.txt'), 'source\n')
    git(movedFixture.source, ['add', 'source.txt'])
    git(movedFixture.source, ['commit', '-m', 'source moved'])
    await expect(moved.ctx.taskReview.apply({
      assignment: moved.assignment,
      expectedRevision: movedReview.revision,
      expectedSourceHead: movedReview.sourceHead,
      commit: movedCommit.commit,
    })).rejects.toMatchObject({ code: 'REVIEW_SOURCE_MOVED' } satisfies Partial<TaskReviewError>)
    await moved.dispose()

    const conflictFixture = repository()
    const conflict = await mount(conflictFixture)
    writeFileSync(join(conflict.assignment.path, 'tracked.txt'), 'task side\n')
    let conflictReview = await conflict.ctx.taskReview.summarize({ assignment: conflict.assignment })
    const conflictCommit = await conflict.ctx.taskReview.commit({
      assignment: conflict.assignment,
      expectedRevision: conflictReview.revision,
      message: 'Task side',
    })
    writeFileSync(join(conflictFixture.source, 'tracked.txt'), 'source side\n')
    git(conflictFixture.source, ['add', 'tracked.txt'])
    git(conflictFixture.source, ['commit', '-m', 'source side'])
    conflictReview = await conflict.ctx.taskReview.summarize({ assignment: conflict.assignment })
    const beforeStatus = git(conflictFixture.source, ['status', '--porcelain=v1', '-z'])
    const beforeIndex = git(conflictFixture.source, ['diff', '--cached', '--binary'])
    const conflictFailure = await conflict.ctx.taskReview.apply({
      assignment: conflict.assignment,
      expectedRevision: conflictReview.revision,
      expectedSourceHead: conflictReview.sourceHead,
      commit: conflictCommit.commit,
    }).then(() => undefined, (error: unknown) => error)
    expect(conflictFailure).toMatchObject({ code: 'REVIEW_APPLY_CONFLICT' } satisfies Partial<TaskReviewError>)
    expect(git(conflictFixture.source, ['status', '--porcelain=v1', '-z'])).toBe(beforeStatus)
    expect(git(conflictFixture.source, ['diff', '--cached', '--binary'])).toBe(beforeIndex)
    expect(readFileSync(join(conflictFixture.source, 'tracked.txt'), 'utf8')).toBe('source side\n')
    await conflict.dispose()
  }, 20_000)

  it('requires loss confirmation and preserves committed branches when discarding worktrees', async () => {
    const dirtyFixture = repository()
    const dirty = await mount(dirtyFixture)
    writeFileSync(join(dirty.assignment.path, 'uncommitted.txt'), 'cannot recover from branch\n')
    const dirtyReview = await dirty.ctx.taskReview.summarize({ assignment: dirty.assignment })
    await expect(dirty.ctx.taskReview.discard({
      assignment: dirty.assignment,
      expectedRevision: dirtyReview.revision,
      confirmedUncommittedLoss: false,
    })).rejects.toMatchObject({ code: 'REVIEW_CONFIRMATION_REQUIRED' } satisfies Partial<TaskReviewError>)
    expect(existsSync(dirty.assignment.path)).toBe(true)
    const discarded = await dirty.ctx.taskReview.discard({
      assignment: dirty.assignment,
      expectedRevision: dirtyReview.revision,
      confirmedUncommittedLoss: true,
    })
    expect(discarded).toMatchObject({
      kind: 'discard',
      reviewRevision: dirtyReview.revision,
      branch: dirty.assignment.branch,
      branchPreserved: true,
      worktreeRemoved: true,
      uncommittedChangesDiscarded: true,
    })
    expect(discarded).not.toHaveProperty('recoverableCommit')
    expect(existsSync(dirty.assignment.path)).toBe(false)
    expect(git(dirtyFixture.source, ['show-ref', '--verify', `refs/heads/${dirty.assignment.branch}`]).trim())
      .toBe(`${dirty.assignment.baseCommit} refs/heads/${dirty.assignment.branch}`)
    await dirty.dispose()

    const committedFixture = repository()
    const committed = await mount(committedFixture)
    writeFileSync(join(committed.assignment.path, 'tracked.txt'), 'recoverable\n')
    const reviewed = await committed.ctx.taskReview.summarize({ assignment: committed.assignment })
    const commit = await committed.ctx.taskReview.commit({
      assignment: committed.assignment,
      expectedRevision: reviewed.revision,
      message: 'Recoverable',
    })
    const ready = await committed.ctx.taskReview.summarize({ assignment: committed.assignment })
    const receipt = await committed.ctx.taskReview.discard({
      assignment: committed.assignment,
      expectedRevision: ready.revision,
      confirmedUncommittedLoss: false,
    })
    expect(receipt).toMatchObject({
      branchPreserved: true,
      worktreeRemoved: true,
      uncommittedChangesDiscarded: false,
      recoverableCommit: commit.commit,
    })
    expect(git(committedFixture.source, ['rev-parse', committed.assignment.branch]).trim()).toBe(commit.commit)
    await committed.dispose()
  })

  it('rejects delivery when configured review or Apply bounds hide required content', async () => {
    const fileFixture = repository()
    const fileBound = await mount(fileFixture, { maxFiles: 1 })
    writeFileSync(join(fileBound.assignment.path, 'one.txt'), 'one\n')
    writeFileSync(join(fileBound.assignment.path, 'two.txt'), 'two\n')
    const truncated = await fileBound.ctx.taskReview.summarize({ assignment: fileBound.assignment })
    expect(truncated).toMatchObject({ truncated: true })
    await expect(fileBound.ctx.taskReview.commit({
      assignment: fileBound.assignment,
      expectedRevision: truncated.revision,
      message: 'Hidden file',
    })).rejects.toMatchObject({ code: 'REVIEW_INCOMPLETE' } satisfies Partial<TaskReviewError>)
    await fileBound.dispose()

    const patchFixture = repository()
    const patchBound = await mount(patchFixture, {
      maxOutputBytes: 1024,
      maxDiffBytes: 128,
      maxPatchBytes: 64,
    })
    writeFileSync(join(patchBound.assignment.path, 'tracked.txt'), 'large task change\n'.repeat(20))
    let reviewed = await patchBound.ctx.taskReview.summarize({ assignment: patchBound.assignment })
    const committed = await patchBound.ctx.taskReview.commit({
      assignment: patchBound.assignment,
      expectedRevision: reviewed.revision,
      message: 'Large patch',
    })
    reviewed = await patchBound.ctx.taskReview.summarize({ assignment: patchBound.assignment })
    await expect(patchBound.ctx.taskReview.apply({
      assignment: patchBound.assignment,
      expectedRevision: reviewed.revision,
      expectedSourceHead: reviewed.sourceHead,
      commit: committed.commit,
    })).rejects.toMatchObject({ code: 'REVIEW_INCOMPLETE' } satisfies Partial<TaskReviewError>)
    await patchBound.dispose()
  })
})
