/** Non-mutating Git classification of authorized deliveries whose execution receipt is missing. */

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, lstat, mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { TaskReviewError } from '@deepseek-ai/dsh-task-review'
import type {
  InspectTaskDeliveryRequest, TaskDeliveryIntent, TaskDeliveryInspection, TaskDeliveryInspectionRevision, TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { parseWorktreeList, type runGit } from '@deepseek-ai/dsh-task-worktree-local'

interface InspectionHost {
  readonly maxPatchBytes: number
  summarize(assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<TaskReviewSummary>
  command(cwd: string, args: readonly string[], signal?: AbortSignal, accepted?: readonly number[],
    stdinData?: string, env?: NodeJS.ProcessEnv): ReturnType<typeof runGit>
}

type Result =
  | Extract<TaskDeliveryInspection, { status: 'completed' | 'ambiguous' }>
  | Extract<TaskDeliveryInspection, { status: 'not-completed' }>
type Classification =
  | Pick<Extract<Result, { status: 'completed' }>, 'status' | 'effect'>
  | Pick<Extract<Result, { status: 'ambiguous' }>, 'status' | 'reason'>
  | Pick<Extract<Result, { status: 'not-completed' }>, 'status'>

const OBJECT_ID = /^[0-9a-f]{40}$/u

/* v8 ignore next 3 -- The same-process discriminant is exhaustive; wire and durable parsers reject unknown delivery kinds. */
function assertNever(value: never): never {
  throw new Error(`Unexpected delivery kind: ${JSON.stringify(value)}`)
}

function objectId(value: string): string {
  const normalized = value.trim()
  if (!OBJECT_ID.test(normalized)) throw new TaskReviewError('Git returned an invalid delivery object id.', 'REVIEW_GIT_FAILED')
  return normalized
}

async function removeIndex(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function withIndexes<T>(operation: (actual: string, expected: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-delivery-inspection-'))
  const actual = join(directory, 'actual')
  const expected = join(directory, 'expected')
  try {
    await chmod(directory, 0o700)
    return await operation(actual, expected)
  } finally {
    for (const path of [actual, `${actual}.lock`, expected, `${expected}.lock`]) await removeIndex(path)
    await rmdir(directory)
  }
}

interface Checkout {
  readonly tree?: string
  readonly filesMatch: boolean
}

async function checkout(host: InspectionHost, cwd: string, index: string, signal?: AbortSignal): Promise<Checkout> {
  const current = (await host.command(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], signal)).stdout.trim()
  if (!isAbsolute(current)) throw new TaskReviewError('Git returned an invalid delivery index path.', 'REVIEW_GIT_FAILED')
  await copyFile(current, index, constants.COPYFILE_EXCL)
  const env = { GIT_INDEX_FILE: index }
  const written = await host.command(cwd, ['write-tree'], signal, [0, 128], undefined, env)
  if (written.exitCode !== 0) return { filesMatch: false }
  const tree = objectId(written.stdout)
  // A fresh index has no stat cache, assume-unchanged, or skip-worktree flags hiding physical edits.
  await unlink(index)
  await host.command(cwd, ['read-tree', tree], signal, undefined, undefined, env)
  const refreshed = await host.command(cwd, ['update-index', '--really-refresh'], signal, [0, 1], undefined, env)
  if (refreshed.exitCode !== 0) return { tree, filesMatch: false }
  const [changed, untracked] = await Promise.all([
    host.command(cwd, ['diff-files', '--quiet', '--ignore-submodules=none', '--'], signal, [0, 1], undefined, env),
    host.command(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], signal, undefined, undefined, env),
  ])
  return { tree, filesMatch: changed.exitCode === 0 && untracked.stdout.length === 0 }
}

async function cleanAt(host: InspectionHost, cwd: string, head: string, signal?: AbortSignal): Promise<boolean> {
  return withIndexes(async (index) => {
    const inspected = await checkout(host, cwd, index, signal)
    const tree = objectId((await host.command(cwd, ['rev-parse', '--verify', `${head}^{tree}`], signal)).stdout)
    return inspected.tree === tree && inspected.filesMatch
  })
}

async function summaryFor(host: InspectionHost, assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<TaskReviewSummary> {
  const summary = await host.summarize(assignment, signal)
  if (summary.truncated) throw new TaskReviewError('The complete Task review is required for delivery inspection.', 'REVIEW_INCOMPLETE')
  return summary
}

async function inspectCommit(
  assignment: TaskWorktreeAssignment, intent: Extract<TaskDeliveryIntent, { kind: 'commit' }>,
  host: InspectionHost, signal?: AbortSignal,
): Promise<Classification> {
  const summary = await summaryFor(host, assignment, signal)
  if (summary.headCommit === intent.headCommit && summary.revision === intent.reviewRevision) return { status: 'not-completed' }
  const identity = await host.command(assignment.path, ['show', '--no-patch', '--format=%P%n%T', summary.headCommit], signal)
  if (identity.stdout.trim() !== `${intent.headCommit}\n${intent.tree}`
    || !await cleanAt(host, assignment.path, summary.headCommit, signal)) {
    return { status: 'ambiguous', reason: 'task-changed' }
  }
  return { status: 'completed', effect: { kind: 'commit', commit: summary.headCommit,
    committedRevision: summary.revision, headBefore: intent.headCommit, tree: intent.tree, branch: assignment.branch } }
}

async function inspectApply(
  assignment: TaskWorktreeAssignment, intent: Extract<TaskDeliveryIntent, { kind: 'apply' }>,
  host: InspectionHost, signal?: AbortSignal,
): Promise<Classification> {
  const summary = await summaryFor(host, assignment, signal)
  if (summary.headCommit !== intent.commit || summary.revision !== intent.reviewRevision
    || !await cleanAt(host, assignment.path, intent.commit, signal)) return { status: 'ambiguous', reason: 'task-changed' }
  if (summary.sourceHead !== intent.sourceHead) return { status: 'ambiguous', reason: 'source-changed' }
  const patch = await host.command(assignment.path, ['diff', '--binary', '--full-index', assignment.baseCommit, intent.commit, '--'], signal)
  if (Buffer.byteLength(patch.stdout) > host.maxPatchBytes) {
    throw new TaskReviewError('The Task patch exceeds the configured delivery inspection bound.', 'REVIEW_INCOMPLETE')
  }
  if (patch.stdout.length === 0) return { status: 'ambiguous', reason: 'task-changed' }
  return withIndexes(async (actual, expected) => {
    const env = { GIT_INDEX_FILE: expected }
    await host.command(assignment.sourcePath, ['read-tree', intent.sourceHead], signal, undefined, undefined, env)
    const simulation = await host.command(assignment.sourcePath, ['apply', '--3way', '--cached', '--whitespace=nowarn', '-'],
      signal, [0, 1, 128], patch.stdout, env)
    if (simulation.exitCode !== 0) return { status: 'ambiguous', reason: 'source-changed' }
    const target = objectId((await host.command(assignment.sourcePath, ['write-tree'], signal, undefined, undefined, env)).stdout)
    const source = await checkout(host, assignment.sourcePath, actual, signal)
    if (!source.filesMatch) return { status: 'ambiguous', reason: 'source-changed' }
    if (source.tree === target) {
      return { status: 'completed', effect: { kind: 'apply', commit: intent.commit, sourceHead: intent.sourceHead, sourceTree: target } }
    }
    const baseline = objectId((await host.command(assignment.sourcePath, ['rev-parse', '--verify', `${intent.sourceHead}^{tree}`], signal)).stdout)
    return source.tree === baseline ? { status: 'not-completed' } : { status: 'ambiguous', reason: 'source-changed' }
  })
}

async function inspectDiscard(
  assignment: TaskWorktreeAssignment, intent: Extract<TaskDeliveryIntent, { kind: 'discard' }>,
  host: InspectionHost, signal?: AbortSignal,
): Promise<Classification> {
  let exists = true
  try {
    const metadata = await lstat(assignment.path)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { status: 'ambiguous', reason: 'discard-incomplete' }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    exists = false
  }
  if (exists) {
    const summary = await summaryFor(host, assignment, signal)
    const status = await host.command(assignment.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal)
    return summary.headCommit === intent.headCommit && summary.revision === intent.reviewRevision
      && (status.stdout.length > 0) === intent.uncommittedChanges
      ? { status: 'not-completed' } : { status: 'ambiguous', reason: 'task-changed' }
  }
  const listing = await host.command(assignment.sourcePath, ['worktree', 'list', '--porcelain', '-z'], signal)
  if (parseWorktreeList(listing.stdout).some(record => resolve(record.path) === resolve(assignment.path)
    || record.branch === `refs/heads/${assignment.branch}`)) return { status: 'ambiguous', reason: 'discard-incomplete' }
  const branch = await host.command(assignment.sourcePath, ['rev-parse', '--verify', `refs/heads/${assignment.branch}`], signal, [0, 128])
  if (branch.exitCode !== 0 || objectId(branch.stdout) !== intent.headCommit) return { status: 'ambiguous', reason: 'discard-incomplete' }
  const ancestry = await host.command(assignment.sourcePath, ['merge-base', '--is-ancestor', assignment.baseCommit, intent.headCommit], signal, [0, 1])
  if (ancestry.exitCode !== 0) return { status: 'ambiguous', reason: 'discard-incomplete' }
  return { status: 'completed', effect: { kind: 'discard', branch: assignment.branch, headCommit: intent.headCommit,
    worktreeRemoved: true, branchPreserved: true, uncommittedChangesDiscarded: intent.uncommittedChanges,
    ...intent.headCommit === assignment.baseCommit ? {} : { recoverableCommit: intent.headCommit } } }
}

/**
 * Inspect current Git facts twice inside the caller-owned repository queue.
 * @param request - Immutable recorded assignment and pending authorization.
 * @param host - Bounded Git commands, complete reviews, and the configured patch limit.
 * @param signal - Optional cancellation; never authorizes retry or mutation.
 * @returns A detached observation without an execution timestamp or a successful-delivery receipt.
 */
export async function inspectTaskDelivery(
  request: InspectTaskDeliveryRequest, host: InspectionHost, signal?: AbortSignal,
): Promise<TaskDeliveryInspection> {
  const inspect = () => {
    switch (request.intent.kind) {
      case 'commit': return inspectCommit(request.assignment, request.intent, host, signal)
      case 'apply': return inspectApply(request.assignment, request.intent, host, signal)
      case 'discard': return inspectDiscard(request.assignment, request.intent, host, signal)
      /* v8 ignore next -- Typed callers cannot add a delivery kind; wire and durable parsers own rejection. */
      default: return assertNever(request.intent)
    }
  }
  const first = await inspect()
  const second = await inspect()
  const result: Classification = JSON.stringify(first) === JSON.stringify(second)
    ? second : { status: 'ambiguous', reason: 'state-changed' }
  const revision = createHash('sha256').update(JSON.stringify({ assignment: request.assignment, intent: request.intent, result }))
    .digest('hex') as TaskDeliveryInspectionRevision
  return { taskId: request.assignment.taskId, workspaceId: request.assignment.workspaceId,
    intent: { ...request.intent }, revision, observedAt: Date.now(), ...result }
}
