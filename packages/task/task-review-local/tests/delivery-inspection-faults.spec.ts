import { existsSync, rmdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorizeDelivery, cleanupFixtures, git, mount, repository } from './fixture.ts'

const faults = vi.hoisted(() => ({ lstatPath: '', unlinkLock: false, failedLock: '' }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...original,
    lstat: async (path: string) => {
      if (path === faults.lstatPath) throw Object.assign(new Error('Cannot inspect directory'), { code: 'EACCES' })
      return original.lstat(path)
    },
    unlink: async (path: string) => {
      if (faults.unlinkLock && path.includes('dsh-delivery-inspection-') && path.endsWith('expected.lock')) {
        faults.failedLock = path
        throw Object.assign(new Error('Cannot clean private index lock'), { code: 'EACCES' })
      }
      return original.unlink(path)
    },
  }
})

afterEach(() => {
  faults.lstatPath = ''
  faults.unlinkLock = false
  faults.failedLock = ''
  vi.restoreAllMocks()
  cleanupFixtures()
})

// The fixture authorizes real deliveries before fault injection; all spawned Git processes must settle.
describe('delivery inspection process and filesystem failures', { timeout: 20_000 }, () => {
  it.each(['invalid-tree', 'relative-index', 'unmerged-index', 'changed-after-refresh'] as const)(
    'does not adopt a Commit with %s', async (mode) => {
      const fixture = repository()
      const test = await mount(fixture)
      try {
        const intent = await authorizeDelivery(test, 'commit', true)
        const spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
        let temporaryIndex: string | undefined
        vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
          const handle = spawn(spec)
          temporaryIndex = spec.env?.GIT_INDEX_FILE ?? temporaryIndex
          const matches = mode === 'relative-index' ? spec.argv.includes('--git-path')
            : mode === 'changed-after-refresh' ? spec.argv.includes('diff-files')
              : spec.argv.includes('write-tree') && spec.env?.GIT_INDEX_FILE !== undefined
          if (!matches) return handle
          if (mode === 'unmerged-index' || mode === 'changed-after-refresh') {
            return { ...handle, done: handle.done.then(result => ({ ...result, exitCode: mode === 'unmerged-index' ? 128 : 1 })) }
          }
          const stdout = mode === 'relative-index' ? 'relative.index' : 'invalid object id'
          return { ...handle, collected: { ...handle.collected,
            stdout: { readFrom: () => ({ nextOffset: Buffer.byteLength(stdout), text: stdout, lossy: false }) },
          } }
        })
        const operation = test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })
        if (mode === 'relative-index' || mode === 'invalid-tree') await expect(operation).rejects.toMatchObject({ code: 'REVIEW_GIT_FAILED' })
        else await expect(operation).resolves.toMatchObject({ status: 'ambiguous', reason: 'task-changed' })
        if (temporaryIndex !== undefined) expect(existsSync(dirname(temporaryIndex))).toBe(false)
      } finally { await test.dispose() }
    },
  )

  it.each(['empty-patch', 'oversized-patch', 'simulation-conflict'] as const)(
    'does not adopt an Apply with %s', async (mode) => {
      const fixture = repository()
      const test = await mount(fixture, { maxPatchBytes: 2048 })
      try {
        const intent = await authorizeDelivery(test, 'apply', false)
        const spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
        let temporaryIndex: string | undefined
        vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
          const handle = spawn(spec)
          temporaryIndex = spec.env?.GIT_INDEX_FILE ?? temporaryIndex
          if (mode === 'simulation-conflict') {
            return spec.argv.includes('apply') && spec.argv.includes('--cached')
              ? { ...handle, done: handle.done.then(result => ({ ...result, exitCode: 1 })) } : handle
          }
          if (!spec.argv.includes('--full-index')) return handle
          const stdout = mode === 'empty-patch' ? '' : 'x'.repeat(2049)
          return { ...handle, collected: { ...handle.collected,
            stdout: { readFrom: () => ({ nextOffset: Buffer.byteLength(stdout), text: stdout, lossy: false }) },
          } }
        })
        const operation = test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })
        if (mode === 'oversized-patch') await expect(operation).rejects.toMatchObject({ code: 'REVIEW_INCOMPLETE' })
        else await expect(operation).resolves.toMatchObject({ status: 'ambiguous', reason: mode === 'empty-patch' ? 'task-changed' : 'source-changed' })
        if (temporaryIndex !== undefined) expect(existsSync(dirname(temporaryIndex))).toBe(false)
        expect(git(fixture.source, ['status', '--porcelain=v1']).trim()).toBe('')
      } finally { await test.dispose() }
    },
  )

  it.each(['commit', 'apply', 'discard'] as const)('requires a complete %s review', async (kind) => {
    const fixture = repository()
    const test = await mount(fixture, { maxFiles: 2 })
    try {
      const intent = await authorizeDelivery(test, kind, false)
      writeFileSync(join(test.assignment.path, 'extra.txt'), 'beyond the configured file limit\n')
      await expect(test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .rejects.toMatchObject({ code: 'REVIEW_INCOMPLETE' })
    } finally { await test.dispose() }
  })

  it.each(['head', 'review', 'hidden-files'] as const)('rejects an Apply after Task %s changes', async (mode) => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'apply', false)
      if (mode === 'head') git(test.assignment.path, ['commit', '--allow-empty', '-m', 'External commit'])
      else {
        const name = mode === 'review' ? 'tracked.txt' : 'rename-me.txt'
        if (mode === 'hidden-files') git(test.assignment.path, ['update-index', '--assume-unchanged', name])
        writeFileSync(join(test.assignment.path, name), 'changed after authorization\n')
      }
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'task-changed' })
    } finally { await test.dispose() }
  })

  it.each(['head', 'review'] as const)('rejects a retained Discard directory with changed %s', async (mode) => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'discard', false)
      if (mode === 'head') git(test.assignment.path, ['commit', '--allow-empty', '-m', 'External commit'])
      else writeFileSync(join(test.assignment.path, 'tracked.txt'), 'changed review\n')
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'task-changed' })
    } finally { await test.dispose() }
  })

  it('rejects lost Discard ancestry and preserves an inaccessible directory error', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'discard', false)
      faults.lstatPath = test.assignment.path
      await expect(test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })).rejects.toMatchObject({ code: 'EACCES' })
      faults.lstatPath = ''
      await test.ctx.taskReview.discard({
        assignment: test.assignment, expectedRevision: intent.reviewRevision, confirmedUncommittedLoss: true,
      })
      const spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
      vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
        const handle = spawn(spec)
        return spec.argv.includes('merge-base') ? { ...handle, done: handle.done.then(result => ({ ...result, exitCode: 1 })) } : handle
      })
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'discard-incomplete' })
    } finally { await test.dispose() }
  })

  it('reports ambiguity when Git changes between its two observations', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'commit', true)
      const spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
      let listing = 0
      vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
        if (spec.argv.includes('worktree') && spec.argv.includes('list') && ++listing === 2) {
          writeFileSync(join(test.assignment.path, 'tracked.txt'), 'concurrent external change\n')
        }
        return spawn(spec)
      })
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'state-changed' })
    } finally { await test.dispose() }
  })

  it('reports private-index cleanup failure instead of returning a completed observation', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'commit', true)
      faults.unlinkLock = true
      await expect(test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent })).rejects.toMatchObject({ code: 'EACCES' })
      expect(faults.failedLock).toContain('dsh-delivery-inspection-')
    } finally {
      faults.unlinkLock = false
      if (faults.failedLock !== '') rmdirSync(dirname(faults.failedLock))
      await test.dispose()
    }
  })

  it('rejects linked source roots and linked replacements of removed Task directories', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'discard', true)
      const sourceLink = join(fixture.root, 'source-link')
      symlinkSync(fixture.source, sourceLink, 'junction')
      await expect(test.ctx.taskReview.inspectDelivery({ assignment: { ...test.assignment, sourcePath: sourceLink }, intent }))
        .rejects.toMatchObject({ code: 'REVIEW_WORKTREE_DIVERGED' })
      symlinkSync(fixture.source, test.assignment.path, 'junction')
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }))
        .toMatchObject({ status: 'ambiguous', reason: 'discard-incomplete' })
    } finally { await test.dispose() }
  })

  it('honors caller cancellation and observes a clean retained directory without mutation', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const intent = await authorizeDelivery(test, 'discard', false, false)
      const abort = new AbortController()
      expect(await test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }, abort.signal)).toMatchObject({ status: 'not-completed' })
      abort.abort()
      await expect(test.ctx.taskReview.inspectDelivery({ assignment: test.assignment, intent }, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
    } finally { await test.dispose() }
  })
})
