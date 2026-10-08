import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskReviewError, TaskReviewOperationId, type TaskDeliveryAuthorization } from '@deepseek-ai/dsh-task-review'
import { cleanupFixtures, git, mount, repository } from './fixture.ts'

afterEach(() => {
  cleanupFixtures()
})

describe('local Task review delivery', () => {
  it.each(['commit', 'apply', 'discard'] as const)('awaits %s authorization before mutation and preserves its operation identity', async (method) => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const { assignment, ctx } = test
      writeFileSync(join(assignment.path, 'tracked.txt'), 'authorized change\n')
      let reviewed = await ctx.taskReview.summarize({ assignment })
      let commit = ''
      if (method === 'apply') {
        commit = (await ctx.taskReview.commit({ assignment, expectedRevision: reviewed.revision, message: 'Prepare' })).commit
        reviewed = await ctx.taskReview.summarize({ assignment })
      }
      const sourceBefore = git(fixture.source, ['status', '--porcelain=v1', '-z'])
      const taskBefore = git(assignment.path, ['status', '--porcelain=v1', '-z'])
      const invoke = (authorization: TaskDeliveryAuthorization) => method === 'commit'
        ? ctx.taskReview.commit({ assignment, expectedRevision: reviewed.revision, message: 'Ship', authorization })
        : method === 'apply' ? ctx.taskReview.apply({ assignment, expectedRevision: reviewed.revision,
          expectedSourceHead: reviewed.sourceHead, commit, authorization })
          : ctx.taskReview.discard({ assignment, expectedRevision: reviewed.revision, confirmedUncommittedLoss: true, authorization })
      const operationId = TaskReviewOperationId('00000000-0000-4000-8000-000000000004')
      const denied = vi.fn(async () => { throw new Error('Durability checkpoint failed') })
      await expect(invoke({ operationId, authorize: denied })).rejects.toThrow('Durability checkpoint failed')
      expect(denied).toHaveBeenCalledOnce()
      expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe(sourceBefore)
      expect(git(assignment.path, ['status', '--porcelain=v1', '-z'])).toBe(taskBefore)
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const pending = invoke({ operationId, authorize: async () => {
        entered.resolve(undefined)
        await release.promise
      } })
      await Promise.race([entered.promise, pending.then(() => { throw new Error('Mutation did not await authorization') })])
      try {
        expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe(sourceBefore)
        expect(git(assignment.path, ['status', '--porcelain=v1', '-z'])).toBe(taskBefore)
      } finally {
        release.resolve(undefined)
      }
      expect((await pending).operationId).toBe(operationId)
    } finally {
      await test.dispose()
    }
  })

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

  it('rejects invalid messages and empty commits without moving Task HEAD', async () => {
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
      message: 'Invalid\0message',
    })).rejects.toMatchObject({ code: 'REVIEW_INVALID_MESSAGE' } satisfies Partial<TaskReviewError>)
    await expect(empty.ctx.taskReview.commit({
      assignment: empty.assignment,
      expectedRevision: emptyReview.revision,
      message: 'Nothing',
    })).rejects.toMatchObject({ code: 'REVIEW_EMPTY' } satisfies Partial<TaskReviewError>)
    expect(git(empty.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(empty.assignment.baseCommit)
    await empty.dispose()
  })

  it('rejects a stale commit without moving Task HEAD', async () => {
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
    expect(git(stale.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(stale.assignment.baseCommit)
    await stale.dispose()
  })

  it('rejects a commit without Git author identity without moving Task HEAD', async () => {
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
  })

  it('rejects a failed pre-commit hook without moving Task HEAD', async () => {
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

  it('rejects a worktree changed between review and Git staging', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), 'reviewed\n')
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('add') && spec.argv.includes('-A')) {
        writeFileSync(join(assignment.path, 'tracked.txt'), 'changed during staging\n')
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.commit({
        assignment, expectedRevision: reviewed.revision, message: 'Should not commit',
      })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
      expect(git(assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(assignment.baseCommit)
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })

  it('rejects a commit whose post-commit hook leaves an unreviewed change', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      const hooks = join(fixture.root, 'hooks')
      mkdirSync(hooks)
      const postCommit = join(hooks, 'post-commit')
      writeFileSync(postCommit, '#!/bin/sh\nprintf "late\\n" > late-after-commit.txt\n')
      chmodSync(postCommit, 0o755)
      git(assignment.path, ['config', 'core.hooksPath', hooks])
      writeFileSync(join(assignment.path, 'tracked.txt'), 'reviewed\n')
      const reviewed = await ctx.taskReview.summarize({ assignment })
      await expect(ctx.taskReview.commit({
        assignment, expectedRevision: reviewed.revision, message: 'Hook changes worktree',
      })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
      expect(git(assignment.path, ['rev-parse', 'HEAD']).trim()).not.toBe(assignment.baseCommit)
      expect(git(assignment.path, ['status', '--porcelain=v1', '-z'])).toContain('late-after-commit.txt')
    } finally {
      await test.dispose()
    }
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

  it('rejects invalid Apply identities and a Task worktree changed after Commit', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      writeFileSync(join(assignment.path, 'tracked.txt'), 'task change\n')
      const reviewed = await ctx.taskReview.summarize({ assignment })
      const committed = await ctx.taskReview.commit({ assignment, expectedRevision: reviewed.revision, message: 'Task' })
      const ready = await ctx.taskReview.summarize({ assignment })
      for (const invalid of [
        { commit: 'HEAD', expectedSourceHead: ready.sourceHead, code: 'REVIEW_GIT_FAILED' },
        { commit: committed.commit, expectedSourceHead: 'HEAD', code: 'REVIEW_GIT_FAILED' },
        { commit: 'f'.repeat(40), expectedSourceHead: ready.sourceHead, code: 'REVIEW_STALE' },
      ] as const) {
        await expect(ctx.taskReview.apply({
          assignment, expectedRevision: ready.revision,
          commit: invalid.commit, expectedSourceHead: invalid.expectedSourceHead,
        })).rejects.toMatchObject({ code: invalid.code } satisfies Partial<TaskReviewError>)
      }
      writeFileSync(join(assignment.path, 'late-untracked.txt'), 'later\n')
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: ready.revision,
        commit: committed.commit, expectedSourceHead: ready.sourceHead,
      })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
      const changed = await ctx.taskReview.summarize({ assignment })
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: changed.revision,
        commit: committed.commit, expectedSourceHead: changed.sourceHead,
      })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
      expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('base\n')
    } finally {
      await test.dispose()
    }
  })

  it('rejects an empty patch from a committed Task branch', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      git(assignment.path, ['commit', '--allow-empty', '-m', 'Empty task commit'])
      const ready = await ctx.taskReview.summarize({ assignment })
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: ready.revision,
        commit: ready.headCommit, expectedSourceHead: ready.sourceHead,
      })).rejects.toMatchObject({ code: 'REVIEW_EMPTY' } satisfies Partial<TaskReviewError>)
      expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe('')
    } finally {
      await test.dispose()
    }
  })

  it('rejects Apply when the complete reviewed file list is not visible', async () => {
    const fixture = repository()
    const test = await mount(fixture, { maxFiles: 1 })
    const { assignment, ctx } = test
    try {
      writeFileSync(join(assignment.path, 'tracked.txt'), 'committed task change\n')
      const reviewed = await ctx.taskReview.summarize({ assignment })
      const committed = await ctx.taskReview.commit({
        assignment, expectedRevision: reviewed.revision, message: 'Task',
      })
      writeFileSync(join(assignment.path, 'late-untracked.txt'), 'not part of commit\n')
      const incomplete = await ctx.taskReview.summarize({ assignment })
      expect(incomplete.truncated).toBe(true)
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: incomplete.revision,
        expectedSourceHead: incomplete.sourceHead, commit: committed.commit,
      })).rejects.toMatchObject({ code: 'REVIEW_INCOMPLETE' } satisfies Partial<TaskReviewError>)
      expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe('')
    } finally {
      await test.dispose()
    }
  })

  it('rejects a failed Apply preflight before modifying the source checkout', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), 'task change\n')
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const committed = await ctx.taskReview.commit({ assignment, expectedRevision: reviewed.revision, message: 'Task' })
    const ready = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('apply') && spec.argv.includes('--check')) {
        return {
          done: Promise.resolve({ exitCode: 1, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: 'scripted preflight conflict', lossy: false }) },
          },
        } as unknown as ReturnType<typeof ctx.subprocess.spawn>
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: ready.revision,
        expectedSourceHead: ready.sourceHead, commit: committed.commit,
      })).rejects.toMatchObject({ code: 'REVIEW_APPLY_CONFLICT' } satisfies Partial<TaskReviewError>)
      expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('base\n')
      expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe('')
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })

  it.each([
    ['changed source files', 'REVIEW_SOURCE_DIRTY'],
    ['moved source HEAD', 'REVIEW_SOURCE_MOVED'],
  ] as const)('rejects %s after Apply simulation without writing the Task patch', async (mode, code) => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), 'task change\n')
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const committed = await ctx.taskReview.commit({ assignment, expectedRevision: reviewed.revision, message: 'Task' })
    const ready = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let changed = false
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (!changed && spec.argv.includes('apply') && spec.argv.includes('--cached')) {
        changed = true
        if (mode === 'changed source files') {
          writeFileSync(join(fixture.source, 'late.txt'), 'late source change\n')
        } else {
          writeFileSync(join(fixture.source, 'source-move.txt'), 'new source commit\n')
          git(fixture.source, ['add', 'source-move.txt'])
          git(fixture.source, ['commit', '-m', 'Source moved'])
        }
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: ready.revision,
        expectedSourceHead: ready.sourceHead, commit: committed.commit,
      })).rejects.toMatchObject({ code })
      expect(changed).toBe(true)
      expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('base\n')
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })

  it('rejects a failed isolated-index Apply simulation and removes its temporary index', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    writeFileSync(join(assignment.path, 'tracked.txt'), 'task change\n')
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const committed = await ctx.taskReview.commit({ assignment, expectedRevision: reviewed.revision, message: 'Task' })
    const ready = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    let temporaryIndex: string | undefined
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('apply') && spec.argv.includes('--cached')) {
        temporaryIndex = spec.env?.GIT_INDEX_FILE
        return {
          done: Promise.resolve({ exitCode: 1, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: 'scripted conflict', lossy: false }) },
          },
        } as unknown as ReturnType<typeof ctx.subprocess.spawn>
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: ready.revision,
        expectedSourceHead: ready.sourceHead, commit: committed.commit,
      })).rejects.toMatchObject({ code: 'REVIEW_APPLY_CONFLICT' } satisfies Partial<TaskReviewError>)
      expect(temporaryIndex).toBeDefined()
      expect(existsSync(temporaryIndex!)).toBe(false)
      expect(existsSync(`${temporaryIndex!}.lock`)).toBe(false)
      expect(readFileSync(join(fixture.source, 'tracked.txt'), 'utf8')).toBe('base\n')
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })

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

  it('rejects a discard request after the reviewed worktree changes', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      writeFileSync(join(assignment.path, 'tracked.txt'), 'reviewed\n')
      const reviewed = await ctx.taskReview.summarize({ assignment })
      writeFileSync(join(assignment.path, 'tracked.txt'), 'changed before discard\n')
      await expect(ctx.taskReview.discard({
        assignment, expectedRevision: reviewed.revision, confirmedUncommittedLoss: true,
      })).rejects.toMatchObject({ code: 'REVIEW_STALE' } satisfies Partial<TaskReviewError>)
      expect(existsSync(assignment.path)).toBe(true)
    } finally {
      await test.dispose()
    }
  })

  it('rejects Git removal success when the Task worktree directory remains', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('worktree') && spec.argv.includes('remove')) {
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        } as unknown as ReturnType<typeof ctx.subprocess.spawn>
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.discard({
        assignment, expectedRevision: reviewed.revision, confirmedUncommittedLoss: false,
      })).rejects.toMatchObject({ code: 'REVIEW_GIT_FAILED' } satisfies Partial<TaskReviewError>)
      expect(existsSync(assignment.path)).toBe(true)
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
  })

  it('rejects a removed worktree when Git cannot confirm branch preservation', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('show-ref')) {
        return {
          done: Promise.resolve({ exitCode: 1, signal: null }),
          collected: {
            stdout: { readFrom: () => ({ text: '', lossy: false }) },
            stderr: { readFrom: () => ({ text: '', lossy: false }) },
          },
        } as unknown as ReturnType<typeof ctx.subprocess.spawn>
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.discard({
        assignment, expectedRevision: reviewed.revision, confirmedUncommittedLoss: false,
      })).rejects.toMatchObject({ code: 'REVIEW_GIT_FAILED' } satisfies Partial<TaskReviewError>)
      expect(existsSync(assignment.path)).toBe(false)
    } finally {
      intercepted.mockRestore()
      await test.dispose()
    }
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
    await expect(fileBound.ctx.taskReview.discard({
      assignment: fileBound.assignment,
      expectedRevision: truncated.revision,
      confirmedUncommittedLoss: true,
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
