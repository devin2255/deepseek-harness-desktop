import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeDelivery as authorize, cleanupFixtures, git, mount, repository } from './fixture.ts'

afterEach(() => { vi.restoreAllMocks(); cleanupFixtures() })

function indexBytes(cwd: string): Buffer {
  return readFileSync(git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim())
}

// Each case owns several complete, real Git operations and repeated reads, including Windows process startup.
describe('inspection of delivery without an execution receipt', { timeout: 20_000 }, () => {
  it.each(['commit', 'apply', 'discard'] as const)('observes completed %s without changing Git or inventing execution time', async (kind) => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorize(test, kind, true)
      const sourceHead = git(fixture.source, ['rev-parse', 'HEAD'])
      const sourceIndex = indexBytes(fixture.source)
      const taskIndex = kind === 'discard' ? undefined : indexBytes(test.assignment.path)
      const first = await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })
      const second = await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })
      expect(first).toMatchObject({ status: 'completed', intent, taskId: test.assignment.taskId,
        workspaceId: test.assignment.workspaceId, effect: { kind } })
      expect(Number.isSafeInteger(first.observedAt) && first.observedAt > 0).toBe(true)
      expect(first.revision).toMatch(/^[0-9a-f]{64}$/)
      expect(second.revision).toBe(first.revision)
      if (first.status !== 'completed') throw new Error('No completed observation')
      expect(first.effect).not.toHaveProperty('committedAt')
      expect(first.effect).not.toHaveProperty('appliedAt')
      expect(first.effect).not.toHaveProperty('discardedAt')
      expect(indexBytes(fixture.source)).toEqual(sourceIndex)
      expect(git(fixture.source, ['rev-parse', 'HEAD'])).toBe(sourceHead)
      if (taskIndex !== undefined) expect(indexBytes(test.assignment.path)).toEqual(taskIndex)
      else expect(existsSync(test.assignment.path)).toBe(false)
    } finally { await test.dispose() }
  })

  it.each(['commit', 'apply', 'discard'] as const)('observes absent %s and leaves its original changes available', async (kind) => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorize(test, kind, false)
      const sourceIndex = indexBytes(fixture.source)
      const taskIndex = indexBytes(test.assignment.path)
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })).toMatchObject({ status: 'not-completed', intent })
      expect(indexBytes(fixture.source)).toEqual(sourceIndex)
      expect(indexBytes(test.assignment.path)).toEqual(taskIndex)
      expect(readFileSync(join(test.assignment.path, 'tracked.txt'), 'utf8')).toBe('authorized edit\n')
    } finally { await test.dispose() }
  })

  it('does not classify staging-only preparation as a completed Commit', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorize(test, 'commit', false)
      git(test.assignment.path, ['add', '-A'])
      const preparedIndex = indexBytes(test.assignment.path)
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })).toMatchObject({ status: 'not-completed' })
      expect(indexBytes(test.assignment.path)).toEqual(preparedIndex)
    } finally { await test.dispose() }
  })

  it.each(['tree', 'parent', 'physical', 'hidden-physical'] as const)('rejects a completed Commit with changed %s', async (fault) => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorize(test, 'commit', true)
      if (fault === 'physical' || fault === 'hidden-physical') {
        if (fault === 'hidden-physical') git(test.assignment.path, ['update-index', '--assume-unchanged', 'tracked.txt'])
        writeFileSync(join(test.assignment.path, 'tracked.txt'), 'different edit\n')
      } else {
        writeFileSync(join(test.assignment.path, 'tracked.txt'), 'another tree\n')
        git(test.assignment.path, ['add', '-A'])
        git(test.assignment.path, ['commit', ...fault === 'tree' ? ['--amend'] : [], '-m', 'External change'])
      }
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'task-changed' })
    } finally { await test.dispose() }
  })

  it.each(['unstaged', 'extra-staged', 'untracked', 'assume-unchanged', 'skip-worktree', 'moved-head'] as const)(
    'rejects an Apply with unrelated source %s', async (fault) => {
      const fixture = repository()
      const test = await mount(fixture)
      try {
        const intent = await authorize(test, 'apply', true)
        if (fault === 'moved-head') git(fixture.source, ['commit', '-m', 'External source commit'])
        else if (fault === 'untracked') writeFileSync(join(fixture.source, 'other.txt'), 'unrelated\n')
        else {
          if (fault === 'assume-unchanged' || fault === 'skip-worktree') {
            git(fixture.source, ['update-index', `--${fault}`, 'rename-me.txt'])
          }
          writeFileSync(join(fixture.source, 'rename-me.txt'), 'unrelated modification\n')
          if (fault === 'extra-staged') git(fixture.source, ['add', 'rename-me.txt'])
        }
        const before = indexBytes(fixture.source)
        expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
          .toMatchObject({ status: 'ambiguous', reason: 'source-changed' })
        expect(indexBytes(fixture.source)).toEqual(before)
      } finally { await test.dispose() }
    },
  )

  it('requires the full Apply result in both source index and files', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorize(test, 'apply', false)
      writeFileSync(join(fixture.source, 'tracked.txt'), 'authorized edit\n')
      git(fixture.source, ['add', 'tracked.txt'])
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'source-changed' })
    } finally { await test.dispose() }
  })

  it.each(['branch-missing', 'branch-moved', 'path-replaced', 'registration-retained'] as const)(
    'does not accept incomplete Discard: %s', async (fault) => {
      const fixture = repository()
      const test = await mount(fixture)
      try {
        const intent = await authorize(test, 'discard', fault !== 'registration-retained')
        if (fault === 'registration-retained') renameSync(test.assignment.path, join(fixture.root, 'moved-worktree'))
        else if (fault === 'branch-missing') git(fixture.source, ['branch', '-D', test.assignment.branch])
        else if (fault === 'branch-moved') {
          git(fixture.source, ['commit', '--allow-empty', '-m', 'Another commit'])
          git(fixture.source, ['branch', '-f', test.assignment.branch, 'HEAD'])
        } else writeFileSync(test.assignment.path, 'replacement file\n')
        expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
          .toMatchObject({ status: 'ambiguous', reason: 'discard-incomplete' })
      } finally { await test.dispose() }
    },
  )

  it('retains a removed Task branch as the only available Discard recovery commit', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const summary = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      writeFileSync(join(test.assignment.path, 'tracked.txt'), 'committed change\n')
      const changed = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      const receipt = await test.ctx.taskReview.commit({ assignment: test.assignment, expectedRevision: changed.revision, message: 'Keep branch' })
      const intent = await authorize(test, 'discard', true)
      const result = await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })
      expect(result).toMatchObject({ status: 'completed', effect: { recoverableCommit: receipt.commit, headCommit: receipt.commit } })
      expect(receipt.commit).not.toBe(summary.headCommit)
    } finally { await test.dispose() }
  })

  it('fails when the recorded source root is unavailable or replaced', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorize(test, 'commit', false)
      for (const sourcePath of [join(fixture.root, 'missing'), join(fixture.source, 'tracked.txt')]) {
        await expect(test.ctx.taskReview.inspectDelivery({ assignment: { ...test.assignment, sourcePath }, intent }))
          .rejects.toMatchObject({ code: 'REVIEW_WORKTREE_DIVERGED' })
      }
      const nested = join(fixture.source, 'nested')
      mkdirSync(nested)
      await expect(test.ctx.taskReview.inspectDelivery({ assignment: { ...test.assignment, sourcePath: nested }, intent }))
        .rejects.toMatchObject({ code: 'REVIEW_WORKTREE_DIVERGED' })
    } finally { await test.dispose() }
  })
})
