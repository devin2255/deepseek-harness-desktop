/** Process-output validation and publication ordering for batch integration. */

import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskReviewRevision } from '@deepseek-ai/dsh-task-review'
import type { IntegrateTaskReviewRequest, TaskReviewSummary } from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { integrateTaskReview } from '../src/integration.ts'

const base = 'a'.repeat(40)
const commit = 'b'.repeat(40)
const candidate = 'c'.repeat(40)
const tree = 'd'.repeat(40)
const revision = TaskReviewRevision('r')
const root: TaskWorktreeAssignment = { kind: 'git-worktree', taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'),
  sourcePath: '/source', path: '/root', branch: 'root', baseCommit: base, sourceHead: base,
  sourceDirty: false, sourceStatusDigest: 'e'.repeat(64), createdAt: 1 }
const child: TaskWorktreeAssignment = { ...root, taskId: SessionId('child'), sourcePath: root.path, path: '/child', branch: 'child' }
const request: IntegrateTaskReviewRequest = { assignment: root, expectedRevision: revision, message: 'Integrate',
  inputs: [{ assignment: child, expectedRevision: revision, commit }] }

function fixture(fault = '') {
  const calls: { args: readonly string[]; signal: AbortSignal | undefined }[] = []
  const abort = new AbortController()
  let inspections = 0
  const host: Parameters<typeof integrateTaskReview>[1] = {
    maxInputs: 2,
    async summarize(assignment) {
      inspections++
      if (fault === 'abort-before-publication' && inspections === 4) abort.abort()
      return { taskId: assignment.taskId, workspaceId: assignment.workspaceId, revision,
        baseCommit: base, headCommit: assignment === root ? base : fault === 'moved-child' ? base : commit,
        sourceHead: base, sourceDirty: false, branch: assignment.branch, dirty: true, truncated: fault === 'truncated',
        files: [], additions: 0, deletions: 0 } satisfies TaskReviewSummary
    },
    async command(_cwd, args, signal) {
      calls.push({ args, signal })
      const command = args[0]
      if (command === 'status') return { stdout: fault === 'dirty' ? 'M file\0' : '', stderr: '', exitCode: 0 }
      if (command === 'merge-base') return { stdout: '', stderr: '', exitCode: args[2] === base ? fault === 'baseline' ? 1 : 0 : 1 }
      if (command === 'var') return { stdout: '', stderr: '', exitCode: fault === 'identity' ? 128 : 0 }
      if (command === 'merge-tree') return { stdout: fault === 'tree' ? 'invalid\0'
        : fault.startsWith('path:') ? `${tree}\0${fault.slice(5)}\0\0` : `${tree}\0`, stderr: '', exitCode: fault.startsWith('path:') ? 1 : 0 }
      if (command === 'commit-tree') return { stdout: fault === 'commit' ? 'invalid' : candidate, stderr: '', exitCode: 0 }
      if (command === 'merge' && fault === 'abort-during-publication') abort.abort()
      return { stdout: command === 'rev-parse' ? fault === 'published-head' ? base : candidate : '', stderr: '', exitCode: 0 }
    },
  }
  return { host, calls, abort }
}

it('rejects unsupported contributor selection and messages before running Git', async () => {
  const { host, calls } = fixture()
  const input = request.inputs[0]!
  for (const changed of [
    { ...child, sourcePath: '/foreign' }, { ...child, workspaceId: WorkspaceId('foreign') },
    { ...child, taskId: root.taskId }, { ...child, path: root.path },
  ]) {
    await expect(integrateTaskReview({ ...request, inputs: [{ ...input, assignment: changed }] }, host)).rejects.toMatchObject({ code: 'REVIEW_INVALID_INTEGRATION' })
  }
  for (const inputs of [[], [input, input, input], [input, input],
    [input, { ...input, assignment: { ...child, taskId: SessionId('other') } }], [{ ...input, commit: 'invalid' }]]) {
    await expect(integrateTaskReview({ ...request, inputs }, host)).rejects.toMatchObject({ code: 'REVIEW_INVALID_INTEGRATION' })
  }
  for (const message of [' ', 'a\0b']) {
    await expect(integrateTaskReview({ ...request, message }, host)).rejects.toMatchObject({ code: 'REVIEW_INVALID_MESSAGE' })
  }
  expect(calls).toEqual([])
})

it('rejects incomplete reviews, changed commits, dirty trees, lost ancestry, and missing identity before publication', async () => {
  for (const [fault, code] of [['truncated', 'REVIEW_INCOMPLETE'], ['moved-child', 'REVIEW_STALE'], ['dirty', 'REVIEW_STALE'],
    ['baseline', 'REVIEW_STALE'], ['identity', 'REVIEW_IDENTITY_MISSING']] as const) {
    const { host, calls } = fixture(fault)
    await expect(integrateTaskReview(request, host)).rejects.toMatchObject({ code })
    expect(calls.some(call => call.args[0] === 'merge')).toBe(false)
  }
})

it('rejects malformed Git trees, commits, and unsafe conflict paths without publication', async () => {
  for (const fault of ['tree', 'commit', 'path:/absolute', 'path:a\\b', 'path:a/../b', 'path:a/./b', 'path:a//b']) {
    const { host, calls } = fixture(fault)
    await expect(integrateTaskReview(request, host)).rejects.toMatchObject({ code: 'REVIEW_GIT_FAILED' })
    expect(calls.some(call => call.args[0] === 'merge')).toBe(false)
  }
})

it('observes cancellation before publication and ignores it only for final bounded publication and verification', async () => {
  const before = fixture('abort-before-publication')
  await expect(integrateTaskReview(request, before.host, before.abort.signal)).rejects.toThrow()
  expect(before.calls.some(call => call.args[0] === 'merge')).toBe(false)
  const during = fixture('abort-during-publication')
  expect((await integrateTaskReview(request, during.host, during.abort.signal)).kind).toBe('integrated')
  const start = during.calls.findIndex(call => call.args[0] === 'merge')
  expect(during.calls.slice(start).every(call => call.signal === undefined)).toBe(true)
  const moved = fixture('published-head')
  await expect(integrateTaskReview(request, moved.host)).rejects.toMatchObject({ code: 'REVIEW_STALE' })
  expect(moved.calls.some(call => call.args.includes('reset'))).toBe(false)
})
