/** Real Git writer integration and conflict preservation. */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskReviewRevision } from '@deepseek-ai/dsh-task-review'
import type { TaskIntegrationInput } from '@deepseek-ai/dsh-task-review'
import { cleanupFixtures, git, mount, repository } from './fixture.ts'

afterEach(cleanupFixtures)

async function writer(test: Awaited<ReturnType<typeof mount>>, id: string, path: string, content: string): Promise<TaskIntegrationInput> {
  const assignment = await test.ctx.taskWorktrees.create({
    taskId: SessionId(id), workspaceId: test.assignment.workspaceId, workspacePath: test.assignment.path,
    requireCleanSource: true,
  })
  writeFileSync(join(assignment.path, path), content)
  const before = await test.ctx.taskReview.summarize({ assignment })
  const committed = await test.ctx.taskReview.commit({ assignment, expectedRevision: before.revision, message: `Writer ${id}` })
  return { assignment, expectedRevision: committed.committedRevision, commit: committed.commit }
}

describe('writer batch integration', () => {
  it('finishes root publication before a child delivery enters the same repository queue', async () => {
    const test = await mount(repository())
    const held = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const order: string[] = []
    const pending: Promise<unknown>[] = []
    let restore: (() => void) | undefined
    try {
      const input = await writer(test, 'a', 'a.txt', 'alpha\n')
      const root = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      const other = await test.ctx.taskWorktrees.create({
        taskId: SessionId('unrelated'), workspaceId: test.assignment.workspaceId, workspacePath: repository().source,
      })
      const spawn = test.ctx.subprocess.spawn.bind(test.ctx.subprocess)
      const intercepted = vi.spyOn(test.ctx.subprocess, 'spawn').mockImplementation((spec) => {
        const handle = spawn(spec)
        if (spec.argv.includes('merge-tree')) {
          entered.resolve(undefined)
          // Hold the real Git result, not a fabricated tree, while both delivery requests arrive.
          return { ...handle, done: handle.done.then(async (outcome) => { await held.promise; return outcome }) }
        }
        if (spec.argv.includes('merge') && spec.argv.includes('--ff-only')) order.push('root-publication')
        return handle
      })
      restore = () => { intercepted.mockRestore() }
      const integration = test.ctx.taskReview.integrate({
        assignment: test.assignment, expectedRevision: root.revision, inputs: [input], message: 'Integrate',
      })
      pending.push(integration)
      await entered.promise
      const invalid = { assignment: input.assignment, expectedRevision: input.expectedRevision, message: '' }
      const child = test.ctx.taskReview.commit(invalid).catch((error: unknown) => {
        order.push('child-rejection')
        return error
      })
      pending.push(child)
      const abort = new AbortController()
      const cancelled = test.ctx.taskReview.commit({ ...invalid, message: 'Cancelled writer commit' }, abort.signal)
        .catch((error: unknown) => error)
      pending.push(cancelled)
      // An unrelated repository must remain available while this root publication is held.
      await expect(test.ctx.taskReview.commit({ ...invalid, assignment: other }))
        .rejects.toMatchObject({ code: 'REVIEW_INVALID_MESSAGE' })
      abort.abort()
      held.resolve(undefined)
      expect((await integration).kind).toBe('integrated')
      expect(await child).toMatchObject({ code: 'REVIEW_INVALID_MESSAGE' })
      expect(await cancelled).toMatchObject({ name: 'AbortError' })
      expect(order).toEqual(['root-publication', 'child-rejection'])
      expect(git(input.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(input.commit)
      expect(git(test.assignment.path, ['status', '--porcelain=v1'])).toBe('')
    } finally {
      held.resolve(undefined)
      await Promise.allSettled(pending)
      restore?.()
      await test.dispose()
    }
  }, 30_000)

  it('publishes both reviewed commits only on the root branch and retains contributor branches', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const a = await writer(test, 'a', 'a.txt', 'alpha\n')
      const b = await writer(test, 'b', 'b.txt', 'beta\n')
      writeFileSync(join(test.assignment.path, 'root.txt'), 'committed root work\n')
      git(test.assignment.path, ['add', '.'])
      git(test.assignment.path, ['commit', '-m', 'Root work'])
      const root = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      const result = await test.ctx.taskReview.integrate({
        assignment: test.assignment, expectedRevision: root.revision, inputs: [a, b], message: 'Integrate two writers',
      })
      expect(result.kind).toBe('integrated')
      if (result.kind !== 'integrated') throw new Error('expected integration receipt')
      expect(result.headBefore).toBe(root.headCommit)
      expect(result.headAfter).toBe(git(test.assignment.path, ['rev-parse', 'HEAD']).trim())
      expect(result.contributors.map(input => input.sessionId)).toEqual(['a', 'b'])
      for (const input of [a, b]) {
        expect(git(input.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(input.commit)
        expect(git(test.assignment.path, ['merge-base', '--is-ancestor', input.commit, result.headAfter])).toBe('')
      }
      expect(readFileSync(join(test.assignment.path, 'a.txt'), 'utf8')).toBe('alpha\n')
      expect(readFileSync(join(test.assignment.path, 'b.txt'), 'utf8')).toBe('beta\n')
      expect(readFileSync(join(test.assignment.path, 'root.txt'), 'utf8')).toBe('committed root work\n')
      expect(git(test.assignment.path, ['status', '--porcelain=v1'])).toBe('')
      expect(git(fixture.source, ['status', '--porcelain=v1'])).toBe('')
      expect(git(fixture.source, ['rev-parse', 'HEAD']).trim()).toBe(test.assignment.baseCommit)
      expect(existsSync(join(fixture.source, 'a.txt'))).toBe(false)
    } finally { await test.dispose() }
  }, 30_000)

  it('reports a later contributor conflict without partially publishing the first merge', async () => {
    const fixture = repository()
    const test = await mount(fixture)
    try {
      const a = await writer(test, 'a', 'same.txt', 'alpha\n')
      const b = await writer(test, 'b', 'same.txt', 'beta\n')
      const root = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      const result = await test.ctx.taskReview.integrate({
        assignment: test.assignment, expectedRevision: root.revision, inputs: [a, b], message: 'Integrate conflicting writers',
      })
      expect(result).toMatchObject({ kind: 'conflict', headBefore: root.headCommit, conflictingSessionId: b.assignment.taskId, paths: ['same.txt'] })
      expect(git(test.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(root.headCommit)
      expect(git(test.assignment.path, ['status', '--porcelain=v1'])).toBe('')
      expect(existsSync(join(test.assignment.path, 'same.txt'))).toBe(false)
      expect(readFileSync(join(a.assignment.path, 'same.txt'), 'utf8')).toBe('alpha\n')
      expect(readFileSync(join(b.assignment.path, 'same.txt'), 'utf8')).toBe('beta\n')
      expect(git(fixture.source, ['rev-parse', 'HEAD']).trim()).toBe(test.assignment.baseCommit)
    } finally { await test.dispose() }
  }, 30_000)

  it('rejects empty, duplicate, foreign, and over-limit inputs before publication', async () => {
    const test = await mount(repository(), { maxIntegrationInputs: 1 })
    try {
      const input = await writer(test, 'a', 'a.txt', 'alpha\n')
      const root = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      const foreign = { ...input, assignment: { ...input.assignment, sourcePath: test.assignment.sourcePath } }
      for (const inputs of [[], [input, input], [foreign]]) {
        await expect(test.ctx.taskReview.integrate({ assignment: test.assignment, expectedRevision: root.revision, inputs, message: 'Integrate' }))
          .rejects.toMatchObject({ code: 'REVIEW_INVALID_INTEGRATION' })
      }
      expect(git(test.assignment.path, ['rev-parse', 'HEAD']).trim()).toBe(root.headCommit)
    } finally { await test.dispose() }
  }, 30_000)

  it('refuses stale root and child reviews, uncommitted changes, and repeated integration', async () => {
    const test = await mount(repository())
    try {
      const input = await writer(test, 'a', 'a.txt', 'alpha\n')
      const root = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      const request = { assignment: test.assignment, expectedRevision: root.revision, inputs: [input], message: 'Integrate' }
      await expect(test.ctx.taskReview.integrate({ ...request, expectedRevision: TaskReviewRevision('stale') })).rejects.toMatchObject({ code: 'REVIEW_STALE' })
      await expect(test.ctx.taskReview.integrate({ ...request, inputs: [{ ...input, expectedRevision: TaskReviewRevision('stale') }] })).rejects.toMatchObject({ code: 'REVIEW_STALE' })
      writeFileSync(join(input.assignment.path, 'a.txt'), 'uncommitted writer update\n')
      const dirty = await test.ctx.taskReview.summarize({ assignment: input.assignment })
      await expect(test.ctx.taskReview.integrate({ ...request, inputs: [{ ...input, expectedRevision: dirty.revision }] })).rejects.toMatchObject({ code: 'REVIEW_STALE' })
      writeFileSync(join(input.assignment.path, 'a.txt'), 'alpha\n')
      writeFileSync(join(test.assignment.path, 'tracked.txt'), 'uncommitted root update\n')
      const dirtyRoot = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      await expect(test.ctx.taskReview.integrate({ ...request, expectedRevision: dirtyRoot.revision })).rejects.toMatchObject({ code: 'REVIEW_STALE' })
      writeFileSync(join(test.assignment.path, 'tracked.txt'), 'base\n')
      expect((await test.ctx.taskReview.integrate(request)).kind).toBe('integrated')
      const after = await test.ctx.taskReview.summarize({ assignment: test.assignment })
      await expect(test.ctx.taskReview.integrate({ ...request, expectedRevision: after.revision })).rejects.toMatchObject({ code: 'REVIEW_EMPTY' })
    } finally { await test.dispose() }
  }, 30_000)
})
