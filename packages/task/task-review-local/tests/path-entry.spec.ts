import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupFixtures, git, mount, repository } from './fixture.ts'

const faults = vi.hoisted(() => ({ lstatPath: '', lstatCode: '', failIndexUnlink: false, failedIndexPath: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    lstat: async (path: string) => {
      if (path === faults.lstatPath) {
        throw Object.assign(new Error('scripted path inspection failure'), { code: faults.lstatCode })
      }
      const metadata = await original.lstat(path)
      if (path.endsWith('fake-link.txt')) {
        return Object.assign(Object.create(metadata) as typeof metadata, { isSymbolicLink: () => true })
      }
      if (path.endsWith('fake-special.txt')) {
        return Object.assign(Object.create(metadata) as typeof metadata, {
          isSymbolicLink: () => false,
          isFile: () => false,
        })
      }
      return metadata
    },
    readlink: async (path: string) => path.endsWith('fake-link.txt') ? 'safe-target' : original.readlink(path),
    unlink: async (path: string) => {
      if (faults.failIndexUnlink && path.endsWith('.index') && path.includes('dsh-task-review-')) {
        faults.failedIndexPath = path
        throw Object.assign(new Error('scripted temporary index cleanup failure'), { code: 'EACCES' })
      }
      return original.unlink(path)
    },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>()
  return {
    ...original,
    createReadStream: (
      path: Parameters<typeof original.createReadStream>[0],
      options?: Parameters<typeof original.createReadStream>[1],
    ) => {
      if (String(path).endsWith('fake-stream.txt')) {
        return {
          async * [Symbol.asyncIterator]() {
            yield 'no newline'
            yield Buffer.alloc(0)
          },
        } as unknown as ReturnType<typeof original.createReadStream>
      }
      return original.createReadStream(path, options)
    },
  }
})

afterEach(() => {
  faults.lstatPath = ''
  faults.lstatCode = ''
  faults.failIndexUnlink = false
  faults.failedIndexPath = ''
  cleanupFixtures()
})

describe('Task review path entry inspection', () => {
  it('hashes symlinks and special files without following them, and counts streamed text', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      for (const name of ['fake-link.txt', 'fake-special.txt', 'fake-stream.txt']) {
        writeFileSync(join(assignment.path, name), 'placeholder')
      }
      const summary = await ctx.taskReview.summarize({ assignment }, new AbortController().signal)
      expect(summary.files.find(file => file.path === 'fake-link.txt'))
        .toMatchObject({ status: 'untracked', binary: false, additions: 1, deletions: 0 })
      expect(summary.files.find(file => file.path === 'fake-special.txt'))
        .toMatchObject({ status: 'untracked', binary: true, additions: null, deletions: null })
      expect(summary.files.find(file => file.path === 'fake-stream.txt'))
        .toMatchObject({ status: 'untracked', binary: false, additions: 1, deletions: 0 })
    } finally {
      await test.dispose()
    }
  })

  it('classifies a worktree inspection failure other than disappearance', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      faults.lstatPath = test.assignment.path
      faults.lstatCode = 'EACCES'
      await expect(test.ctx.taskReview.summarize({ assignment: test.assignment }))
        .rejects.toMatchObject({ code: 'REVIEW_WORKTREE_DIVERGED' })
    } finally {
      faults.lstatPath = ''
      await test.dispose()
    }
  })

  it('rejects a removed worktree whose absence cannot be verified', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    const reviewed = await ctx.taskReview.summarize({ assignment })
    const spawn = ctx.subprocess.spawn.bind(ctx.subprocess)
    const intercepted = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation((spec) => {
      if (spec.argv.includes('worktree') && spec.argv.includes('remove')) {
        faults.lstatPath = assignment.path
        faults.lstatCode = 'EACCES'
      }
      return spawn(spec)
    })
    try {
      await expect(ctx.taskReview.discard({
        assignment, expectedRevision: reviewed.revision, confirmedUncommittedLoss: false,
      })).rejects.toMatchObject({ code: 'REVIEW_GIT_FAILED' })
    } finally {
      intercepted.mockRestore()
      faults.lstatPath = ''
      await test.dispose()
    }
  })

  it('propagates a temporary index cleanup error without applying to the source', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    const { assignment, ctx } = test
    try {
      writeFileSync(join(assignment.path, 'tracked.txt'), 'task change\n')
      const reviewed = await ctx.taskReview.summarize({ assignment })
      const committed = await ctx.taskReview.commit({
        assignment, expectedRevision: reviewed.revision, message: 'Task',
      })
      const ready = await ctx.taskReview.summarize({ assignment })
      faults.failIndexUnlink = true
      await expect(ctx.taskReview.apply({
        assignment, expectedRevision: ready.revision,
        expectedSourceHead: ready.sourceHead, commit: committed.commit,
      })).rejects.toThrow('scripted temporary index cleanup failure')
      expect(faults.failedIndexPath).toMatch(/dsh-task-review-[0-9a-f-]+\.index$/u)
      expect(git(fixture.source, ['status', '--porcelain=v1', '-z'])).toBe('')
    } finally {
      faults.failIndexUnlink = false
      if (faults.failedIndexPath) {
        rmSync(faults.failedIndexPath, { force: true })
        rmSync(`${faults.failedIndexPath}.lock`, { force: true })
      }
      await test.dispose()
    }
  })
})
