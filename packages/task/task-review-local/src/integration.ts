/** Batch Git merge preflight and root-only publication for the local review Provider. */

import { randomUUID } from 'node:crypto'
import { TaskReviewError, TaskReviewOperationId } from '@deepseek-ai/dsh-task-review'
import type {
  IntegrateTaskReviewRequest, TaskIntegrationContributor, TaskIntegrationInput, TaskIntegrationResult, TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type { runGit } from '@deepseek-ai/dsh-task-worktree-local'

interface IntegrationHost {
  readonly maxInputs: number
  summarize(assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<TaskReviewSummary>
  command(cwd: string, args: readonly string[], signal?: AbortSignal, accepted?: readonly number[]): ReturnType<typeof runGit>
}

const OBJECT_ID = /^[0-9a-f]{40}$/u

function stale(message: string): never {
  throw new TaskReviewError(message, 'REVIEW_STALE')
}

async function clean(host: IntegrationHost, assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<void> {
  const status = await host.command(assignment.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)
  if (status.stdout.length > 0) stale('Commit all working-tree changes before integrating writer results.')
}

async function inspect(
  host: IntegrationHost, assignment: TaskWorktreeAssignment, revision: string, signal?: AbortSignal,
): Promise<TaskReviewSummary> {
  const summary = await host.summarize(assignment, signal)
  if (summary.revision !== revision) stale('The integration review changed after it was inspected.')
  if (summary.truncated) {
    throw new TaskReviewError('The complete change set must be visible before integration.', 'REVIEW_INCOMPLETE')
  }
  await clean(host, assignment, signal)
  return summary
}

async function inspectInput(host: IntegrationHost, input: TaskIntegrationInput, signal?: AbortSignal): Promise<void> {
  const summary = await inspect(host, input.assignment, input.expectedRevision, signal)
  if (summary.headCommit !== input.commit) stale('The selected writer commit is not its current reviewed HEAD.')
}

function mergeOutput(stdout: string): { tree: string; paths: readonly string[] } {
  const [tree, ...fields] = stdout.split('\0')
  if (tree === undefined || !OBJECT_ID.test(tree)) {
    throw new TaskReviewError('Git returned an invalid integration tree.', 'REVIEW_GIT_FAILED')
  }
  const paths: string[] = []
  for (const field of fields) {
    if (field.length === 0) break
    if (field.startsWith('/') || field.includes('\\') || field.split('/').some(part => part === '..' || part === '.' || part.length === 0)) {
      throw new TaskReviewError('Git returned an invalid integration conflict path.', 'REVIEW_GIT_FAILED')
    }
    paths.push(field)
  }
  return { tree, paths }
}

/**
 * Compute every merge before publishing a single fast-forward on the root branch.
 * @param request - exact root and child revisions, immutable child commits, and commit message.
 * @param host - Provider-owned inspection, bounded Git execution, and configured batch limit.
 * @param signal - cancellation before root publication; final publication and verification ignore caller cancellation.
 * @returns a complete receipt or a conflict without changing any branch or working tree.
 */
export async function integrateTaskReview(
  request: IntegrateTaskReviewRequest, host: IntegrationHost, signal?: AbortSignal,
): Promise<TaskIntegrationResult> {
  const { assignment, inputs } = request
  if (inputs.length === 0 || inputs.length > host.maxInputs) {
    throw new TaskReviewError('Integration requires a non-empty batch within the configured writer limit.', 'REVIEW_INVALID_INTEGRATION')
  }
  if (request.message.trim().length === 0 || request.message.includes('\0')) {
    throw new TaskReviewError('The integration message must contain non-NUL text.', 'REVIEW_INVALID_MESSAGE')
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const input of inputs) {
    if (input.assignment.sourcePath !== assignment.path || input.assignment.workspaceId !== assignment.workspaceId
      || input.assignment.taskId === assignment.taskId || input.assignment.path === assignment.path
      || ids.has(input.assignment.taskId) || paths.has(input.assignment.path) || !OBJECT_ID.test(input.commit)) {
      throw new TaskReviewError('Integration requires distinct direct writer assignments and exact commits.', 'REVIEW_INVALID_INTEGRATION')
    }
    ids.add(input.assignment.taskId)
    paths.add(input.assignment.path)
  }
  const root = await inspect(host, assignment, request.expectedRevision, signal)
  for (const input of inputs) {
    await inspectInput(host, input, signal)
    const baseline = await host.command(assignment.path, ['merge-base', '--is-ancestor', input.assignment.baseCommit, root.headCommit], signal, [0, 1])
    if (baseline.exitCode !== 0) stale('The root no longer contains a selected writer baseline.')
    const included = await host.command(assignment.path, ['merge-base', '--is-ancestor', input.commit, root.headCommit], signal, [0, 1])
    if (included.exitCode === 0) {
      throw new TaskReviewError('A selected writer commit is already integrated.', 'REVIEW_EMPTY')
    }
  }
  const identity = await host.command(assignment.path, ['var', 'GIT_AUTHOR_IDENT'], signal, [0, 128])
  if (identity.exitCode !== 0) {
    throw new TaskReviewError('Git author identity is not configured for integration.', 'REVIEW_IDENTITY_MISSING')
  }
  const contributors: readonly TaskIntegrationContributor[] = Object.freeze(inputs.map(input => Object.freeze({
    sessionId: input.assignment.taskId, branch: input.assignment.branch, commit: input.commit, reviewRevision: input.expectedRevision,
  })))
  const common = {
    operationId: TaskReviewOperationId(randomUUID()), taskId: assignment.taskId, workspaceId: assignment.workspaceId,
    reviewRevision: request.expectedRevision, headBefore: root.headCommit, contributors,
  }
  let candidate = root.headCommit
  for (const input of inputs) {
    const merged = await host.command(assignment.path, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', candidate, input.commit], signal, [0, 1])
    const result = mergeOutput(merged.stdout)
    if (merged.exitCode !== 0) {
      return Object.freeze({ ...common, kind: 'conflict' as const, conflictingSessionId: input.assignment.taskId,
        paths: Object.freeze([...result.paths]), detectedAt: Date.now() })
    }
    const commit = await host.command(assignment.path, ['commit-tree', result.tree, '-p', candidate, '-p', input.commit, '-m', request.message], signal)
    candidate = commit.stdout.trim()
    if (!OBJECT_ID.test(candidate)) {
      throw new TaskReviewError('Git returned an invalid integration commit.', 'REVIEW_GIT_FAILED')
    }
  }
  await inspect(host, assignment, request.expectedRevision, signal)
  for (const input of inputs) await inspectInput(host, input, signal)
  signal?.throwIfAborted()
  // Once publication starts, caller cancellation cannot turn a completed Git mutation into a cancelled result.
  await host.command(assignment.path, ['merge', '--ff-only', '--no-autostash', '--no-edit', '--no-stat', candidate])
  const published = await host.command(assignment.path, ['rev-parse', '--verify', 'HEAD'])
  if (published.stdout.trim() !== candidate) stale('The integration branch changed during publication.')
  await clean(host, assignment)
  return Object.freeze({ ...common, kind: 'integrated' as const, headAfter: candidate, integratedAt: Date.now() })
}
