/** Local Git Provider for Task review and delivery. @module @deepseek-ai/dsh-task-review-local */

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, realpath, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  TaskReviewError,
  TaskReviewOperationId,
  TaskReviewRevision,
  TaskReviewService,
} from '@deepseek-ai/dsh-task-review'
import type {
  ApplyTaskReviewRequest,
  CommitTaskReviewRequest,
  DiscardTaskReviewRequest,
  GetTaskFileDiffRequest,
  SummarizeTaskReviewRequest,
  TaskApplyReceipt,
  TaskCommitReceipt,
  TaskDiscardReceipt,
  TaskFileDiff,
  TaskReviewErrorCode,
  TaskReviewFile,
  TaskReviewSummary,
} from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { parseWorktreeList, runGit } from '@deepseek-ai/dsh-task-worktree-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_PATCH_BYTES,
  DEFAULT_TERMINATE_GRACE_MS,
} from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { parseNameStatus, parseNumstat } from './git.ts'

export * from './config.ts'
export { parseNameStatus, parseNumstat } from './git.ts'

/** User configuration accepted by the local Task review Provider. */
export interface Config {
  /** Bare or absolute Git executable. */
  gitCommand?: string
  /** Deadline for each Git subprocess. */
  commandTimeoutMs?: number
  /** Termination grace for each Git subprocess tree. */
  terminateGraceMs?: number
  /** Per-stream collected-output byte bound. */
  maxOutputBytes?: number
  /** Maximum UTF-8 bytes returned for one file patch. */
  maxDiffBytes?: number
  /** Maximum complete binary patch bytes accepted by Apply. */
  maxPatchBytes?: number
  /** Maximum file rows returned in one summary. */
  maxFiles?: number
}

/** Schemastery declaration used by Cordis configuration loading. */
export const Config: z<Config> = z.object({
  gitCommand: z.string().default('git'),
  commandTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_COMMAND_TIMEOUT_MS),
  terminateGraceMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TERMINATE_GRACE_MS),
  maxOutputBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_OUTPUT_BYTES),
  maxDiffBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_DIFF_BYTES),
  maxPatchBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_PATCH_BYTES),
  maxFiles: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_FILES),
})

/**
 * Resolve all deployment choices once at Provider construction.
 * @param config - User configuration after Cordis schema defaults.
 * @returns Validated command and output limits.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const gitCommand = config.gitCommand ?? 'git'
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const maxDiffBytes = config.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES
  const maxPatchBytes = config.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES
  if (gitCommand.trim().length === 0 || gitCommand !== gitCommand.trim()) {
    throw new Error('task-review-local: gitCommand must be non-empty and normalized')
  }
  if (maxDiffBytes > maxOutputBytes || maxPatchBytes > maxOutputBytes) {
    throw new Error('task-review-local: diff and patch limits must not exceed maxOutputBytes')
  }
  return Object.freeze({
    gitCommand,
    commandTimeoutMs: config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    terminateGraceMs: config.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    maxOutputBytes,
    maxDiffBytes,
    maxPatchBytes,
    maxFiles: config.maxFiles ?? DEFAULT_MAX_FILES,
  })
}

const COMMIT = /^[0-9a-f]{40}$/u

function failure(message: string, code: TaskReviewErrorCode, cause?: unknown): TaskReviewError {
  return new TaskReviewError(message, code, cause === undefined ? undefined : { cause })
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function validReviewPath(path: string): boolean {
  if (path.length === 0 || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false
  return path.split('/').every(part => part.length > 0 && part !== '.' && part !== '..')
}

function truncateUtf8(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value)
  if (bytes.byteLength <= maxBytes) return { text: value, truncated: false }
  let end = maxBytes
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true }
}

async function removeTemporaryIndex(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

interface PathInspection {
  readonly binary: boolean
  readonly additions: number | null
  readonly digest: string
}

async function inspectPathEntry(path: string, signal?: AbortSignal): Promise<PathInspection> {
  const metadata = await lstat(path)
  const hash = createHash('sha256')
  if (metadata.isSymbolicLink()) {
    const target = await readlink(path)
    hash.update(`symlink\0${metadata.mode}\0`).update(target)
    return { binary: false, additions: 1, digest: hash.digest('hex') }
  }
  if (!metadata.isFile()) {
    hash.update(`special\0${metadata.mode}\0${metadata.size}`)
    return { binary: true, additions: null, digest: hash.digest('hex') }
  }
  hash.update(`file\0${metadata.mode}\0`)
  let binary = false
  let lines = 0
  let sawBytes = false
  let endedWithNewline = false
  for await (const chunk of createReadStream(path)) {
    signal?.throwIfAborted()
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    hash.update(bytes)
    if (bytes.includes(0)) binary = true
    for (const byte of bytes) if (byte === 10) lines++
    if (bytes.length > 0) {
      sawBytes = true
      endedWithNewline = bytes.at(-1) === 10
    }
  }
  if (sawBytes && !endedWithNewline) lines++
  return {
    binary,
    additions: binary ? null : lines,
    digest: hash.digest('hex'),
  }
}

interface ReviewState {
  readonly summary: TaskReviewSummary
  readonly allFiles: readonly TaskReviewFile[]
}

interface AssignmentState {
  readonly worktreeHead: string
  readonly sourcePath: string
  readonly sourceHead: string
  readonly sourceDirty: boolean
}

/** Local Provider that treats Git and worktree contents as request-time authority. */
export class LocalTaskReview extends TaskReviewService {
  static inject = ['subprocess']
  static Config = Config

  private executable: Promise<string> | undefined
  private readonly chains = new Map<string, Promise<void>>()
  private readonly config: ResolvedConfig

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
  }

  private async git(signal?: AbortSignal): Promise<string> {
    const cached = this.executable
    if (cached !== undefined) return cached
    const resolution = this.ctx.subprocess.resolveExecutable(this.config.gitCommand, undefined, signal)
    this.executable = resolution
    try {
      return await resolution
    } catch (error) {
      if (this.executable === resolution) this.executable = undefined
      throw failure(`Git executable ${JSON.stringify(this.config.gitCommand)} is unavailable.`, 'REVIEW_GIT_FAILED', error)
    }
  }

  private async command(
    executable: string,
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
    acceptedExitCodes?: readonly number[],
    stdinData?: string,
    env?: NodeJS.ProcessEnv,
  ) {
    try {
      return await runGit(
        this.ctx.subprocess,
        executable,
        cwd,
        args,
        this.config,
        signal,
        acceptedExitCodes,
        stdinData,
        env,
      )
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (error instanceof TaskReviewError) throw error
      throw failure('Git could not inspect the Task worktree.', 'REVIEW_GIT_FAILED', error)
    }
  }

  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => undefined, () => undefined)
    this.chains.set(key, settled)
    return result.finally(() => {
      if (this.chains.get(key) === settled) this.chains.delete(key)
    })
  }

  private async worktreePath(assignment: TaskWorktreeAssignment): Promise<string> {
    try {
      const metadata = await lstat(assignment.path)
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw failure('The recorded Task worktree path is no longer a directory.', 'REVIEW_WORKTREE_DIVERGED')
      }
      const path = await realpath(assignment.path)
      if (path !== assignment.path) {
        throw failure('The recorded Task worktree path resolves to a different directory.', 'REVIEW_WORKTREE_DIVERGED')
      }
      return path
    } catch (error) {
      if (error instanceof TaskReviewError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw failure('The recorded Task worktree is unavailable.', 'REVIEW_WORKTREE_UNAVAILABLE', error)
      }
      throw failure('The recorded Task worktree cannot be inspected.', 'REVIEW_WORKTREE_DIVERGED', error)
    }
  }

  private async validateAssignment(
    executable: string,
    assignment: TaskWorktreeAssignment,
    worktreePath: string,
    signal?: AbortSignal,
  ): Promise<AssignmentState> {
    let sourcePath: string
    try {
      sourcePath = await realpath(assignment.sourcePath)
    } catch (error) {
      throw failure('The recorded source checkout is unavailable.', 'REVIEW_WORKTREE_DIVERGED', error)
    }
    if (sourcePath !== assignment.sourcePath) {
      throw failure('The recorded source checkout resolves to a different directory.', 'REVIEW_WORKTREE_DIVERGED')
    }
    const listing = await this.command(
      executable,
      sourcePath,
      ['worktree', 'list', '--porcelain', '-z'],
      signal,
    )
    let matched = false
    for (const record of parseWorktreeList(listing.stdout)) {
      let recordPath: string
      try {
        recordPath = await realpath(record.path)
      } catch {
        continue
      }
      if (recordPath !== worktreePath) continue
      matched = record.branch === `refs/heads/${assignment.branch}`
      break
    }
    if (!matched) {
      throw failure('The recorded Task worktree no longer matches its Git registration.', 'REVIEW_WORKTREE_DIVERGED')
    }
    const [worktreeHeadResult, sourceHeadResult, sourceStatus] = await Promise.all([
      this.command(executable, worktreePath, ['rev-parse', '--verify', 'HEAD'], signal),
      this.command(executable, sourcePath, ['rev-parse', '--verify', 'HEAD'], signal),
      this.command(executable, sourcePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal),
    ])
    const worktreeHead = worktreeHeadResult.stdout.trim()
    const sourceHead = sourceHeadResult.stdout.trim()
    if (!COMMIT.test(worktreeHead)) throw failure('Git returned an invalid Task worktree HEAD.', 'REVIEW_GIT_FAILED')
    if (!COMMIT.test(sourceHead)) throw failure('Git returned an invalid source checkout HEAD.', 'REVIEW_GIT_FAILED')
    const ancestry = await this.command(
      executable,
      worktreePath,
      ['merge-base', '--is-ancestor', assignment.baseCommit, worktreeHead],
      signal,
      [0, 1],
    )
    if (ancestry.exitCode !== 0) {
      throw failure('The Task worktree no longer descends from its recorded base.', 'REVIEW_WORKTREE_DIVERGED')
    }
    return {
      worktreeHead,
      sourcePath,
      sourceHead,
      sourceDirty: sourceStatus.stdout.length > 0,
    }
  }

  private async state(assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<ReviewState> {
    signal?.throwIfAborted()
    const worktreePath = await this.worktreePath(assignment)
    const executable = await this.git(signal)
    const assignmentState = await this.validateAssignment(executable, assignment, worktreePath, signal)
    const headCommit = assignmentState.worktreeHead
    const [names, numstat, untracked] = await Promise.all([
      this.command(
        executable,
        worktreePath,
        ['diff', '--name-status', '-z', '--find-renames=50%', '--find-copies=50%', assignment.baseCommit, '--'],
        signal,
      ),
      this.command(
        executable,
        worktreePath,
        ['diff', '--numstat', '-z', '--find-renames=50%', '--find-copies=50%', assignment.baseCommit, '--'],
        signal,
      ),
      this.command(executable, worktreePath, ['ls-files', '--others', '--exclude-standard', '-z'], signal),
    ])
    const counts = new Map(parseNumstat(numstat.stdout).map(value => [value.path, value]))
    const files: TaskReviewFile[] = parseNameStatus(names.stdout).map((change) => {
      if (!validReviewPath(change.path) || (change.previousPath !== undefined && !validReviewPath(change.previousPath))) {
        throw failure('Git returned an invalid changed path.', 'REVIEW_GIT_FAILED')
      }
      const values = counts.get(change.path)
      if (values === undefined) throw failure('Git omitted line counts for a changed file.', 'REVIEW_GIT_FAILED')
      return Object.freeze({
        ...change,
        binary: values.additions === null || values.deletions === null,
        additions: values.additions,
        deletions: values.deletions,
      })
    })
    const entryDigests = new Map<string, string>()
    for (const path of untracked.stdout.split('\0').filter(Boolean).sort(lexicalCompare)) {
      if (!validReviewPath(path)) throw failure('Git returned an invalid untracked path.', 'REVIEW_GIT_FAILED')
      const absolutePath = resolve(worktreePath, ...path.split('/'))
      if (absolutePath !== worktreePath && !absolutePath.startsWith(`${worktreePath}${sep}`)) {
        throw failure('Git returned an untracked path outside the Task worktree.', 'REVIEW_GIT_FAILED')
      }
      const inspected = await inspectPathEntry(absolutePath, signal)
      entryDigests.set(path, inspected.digest)
      files.push(Object.freeze({
        path,
        status: 'untracked' as const,
        binary: inspected.binary,
        additions: inspected.additions,
        deletions: inspected.binary ? null : 0,
      }))
    }
    files.sort((left, right) => lexicalCompare(left.path, right.path))
    const revisionHash = createHash('sha256')
      .update(`${assignment.taskId}\0${assignment.workspaceId}\0${assignment.baseCommit}\0${headCommit}\0`)
    for (const file of files) {
      if (file.status === 'renamed' && file.previousPath !== undefined) {
        revisionHash.update(`delete\0${file.previousPath}\0`)
      }
      if (file.status === 'deleted') {
        revisionHash.update(`delete\0${file.path}\0`)
        continue
      }
      let entryDigest = entryDigests.get(file.path)
      if (entryDigest === undefined) {
        const absolutePath = resolve(worktreePath, ...file.path.split('/'))
        entryDigest = (await inspectPathEntry(absolutePath, signal)).digest
      }
      revisionHash.update(`write\0${file.path}\0${entryDigest}\0`)
    }
    const frozenFiles = Object.freeze(files.slice())
    const additions = files.reduce((total, file) => total + (file.additions ?? 0), 0)
    const deletions = files.reduce((total, file) => total + (file.deletions ?? 0), 0)
    const truncated = files.length > this.config.maxFiles
    const summary = Object.freeze({
      taskId: assignment.taskId,
      workspaceId: assignment.workspaceId,
      revision: TaskReviewRevision(revisionHash.digest('hex')),
      baseCommit: assignment.baseCommit,
      headCommit,
      sourceHead: assignmentState.sourceHead,
      sourceDirty: assignmentState.sourceDirty,
      branch: assignment.branch,
      dirty: files.length > 0,
      truncated,
      files: Object.freeze(files.slice(0, this.config.maxFiles)),
      additions,
      deletions,
    })
    return { summary, allFiles: frozenFiles }
  }

  async summarize(
    request: SummarizeTaskReviewRequest,
    signal?: AbortSignal,
  ): Promise<TaskReviewSummary> {
    return (await this.state(request.assignment, signal)).summary
  }

  async diff(request: GetTaskFileDiffRequest, signal?: AbortSignal): Promise<TaskFileDiff> {
    if (!validReviewPath(request.path)) {
      throw failure('The requested review path must be a normalized repository-relative path.', 'REVIEW_INVALID_PATH')
    }
    const { summary, allFiles } = await this.state(request.assignment, signal)
    if (summary.revision !== request.expectedRevision) {
      throw failure('The Task worktree changed after this review was loaded.', 'REVIEW_STALE')
    }
    const file = allFiles.find(candidate => candidate.path === request.path)
    if (file === undefined) throw failure('The requested file is not part of this Task review.', 'REVIEW_FILE_NOT_FOUND')
    let patch = ''
    if (!file.binary) {
      const executable = await this.git(signal)
      const args = file.status === 'untracked'
        ? ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file.path]
        : [
          'diff',
          '--no-ext-diff',
          '--unified=3',
          '--find-renames=50%',
          request.assignment.baseCommit,
          '--',
          ...file.previousPath === undefined ? [] : [file.previousPath],
          file.path,
        ]
      const result = await this.command(
        executable,
        request.assignment.path,
        args,
        signal,
        file.status === 'untracked' ? [0, 1] : undefined,
      )
      patch = result.stdout
    }
    const confirmed = await this.state(request.assignment, signal)
    if (confirmed.summary.revision !== summary.revision) {
      throw failure('The Task worktree changed while its file diff was generated.', 'REVIEW_STALE')
    }
    const bounded = truncateUtf8(patch, this.config.maxDiffBytes)
    return Object.freeze({
      taskId: request.assignment.taskId,
      workspaceId: request.assignment.workspaceId,
      revision: summary.revision,
      path: file.path,
      ...file.previousPath === undefined ? {} : { previousPath: file.previousPath },
      binary: file.binary,
      truncated: bounded.truncated,
      patch: bounded.text,
    })
  }

  async commit(request: CommitTaskReviewRequest, signal?: AbortSignal): Promise<TaskCommitReceipt> {
    return this.serialize(request.assignment.sourcePath, async () => {
      if (request.message.trim().length === 0 || request.message.includes('\0')) {
        throw failure('The commit message must contain non-NUL text.', 'REVIEW_INVALID_MESSAGE')
      }
      const reviewed = await this.state(request.assignment, signal)
      if (reviewed.summary.revision !== request.expectedRevision) {
        throw failure('The Task worktree changed after this review was loaded.', 'REVIEW_STALE')
      }
      if (reviewed.summary.truncated) {
        throw failure('The complete change set must be visible before it can be committed.', 'REVIEW_INCOMPLETE')
      }
      if (!reviewed.summary.dirty) throw failure('The Task worktree has no changes to commit.', 'REVIEW_EMPTY')
      const executable = await this.git(signal)
      const identity = await this.command(
        executable,
        request.assignment.path,
        ['var', 'GIT_AUTHOR_IDENT'],
        signal,
        [0, 128],
      )
      if (identity.exitCode !== 0) {
        throw failure('Git author identity is not configured for this Task worktree.', 'REVIEW_IDENTITY_MISSING')
      }
      await this.command(executable, request.assignment.path, ['add', '-A', '--'], signal)
      const staged = await this.state(request.assignment, signal)
      if (staged.summary.revision !== request.expectedRevision) {
        throw failure('The Task worktree changed while its commit was prepared.', 'REVIEW_STALE')
      }
      await this.command(
        executable,
        request.assignment.path,
        ['commit', '--no-gpg-sign', '-m', request.message],
        signal,
      )
      const committed = await this.state(request.assignment, signal)
      const status = await this.command(
        executable,
        request.assignment.path,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        signal,
      )
      if (status.stdout.length > 0) {
        throw failure('The Task worktree changed while its commit completed.', 'REVIEW_STALE')
      }
      return Object.freeze({
        kind: 'commit' as const,
        operationId: TaskReviewOperationId(randomUUID()),
        taskId: request.assignment.taskId,
        workspaceId: request.assignment.workspaceId,
        reviewRevision: request.expectedRevision,
        committedRevision: committed.summary.revision,
        branch: request.assignment.branch,
        commit: committed.summary.headCommit,
        committedAt: Date.now(),
      })
    })
  }

  async apply(request: ApplyTaskReviewRequest, signal?: AbortSignal): Promise<TaskApplyReceipt> {
    return this.serialize(request.assignment.sourcePath, async () => {
      if (!COMMIT.test(request.commit) || !COMMIT.test(request.expectedSourceHead)) {
        throw failure('Apply requires exact Git commit identities.', 'REVIEW_GIT_FAILED')
      }
      const reviewed = await this.state(request.assignment, signal)
      if (reviewed.summary.revision !== request.expectedRevision) {
        throw failure('The Task worktree changed after this review was loaded.', 'REVIEW_STALE')
      }
      if (reviewed.summary.truncated) {
        throw failure('The complete change set must be visible before it can be applied.', 'REVIEW_INCOMPLETE')
      }
      if (reviewed.summary.headCommit !== request.commit) {
        throw failure('The requested commit is not the current reviewed Task commit.', 'REVIEW_STALE')
      }
      const executable = await this.git(signal)
      const worktreeStatus = await this.command(
        executable,
        request.assignment.path,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        signal,
      )
      if (worktreeStatus.stdout.length > 0) {
        throw failure('Commit the Task worktree before applying it.', 'REVIEW_STALE')
      }
      if (reviewed.summary.sourceDirty) {
        throw failure('The source checkout must be clean before applying a Task commit.', 'REVIEW_SOURCE_DIRTY')
      }
      if (reviewed.summary.sourceHead !== request.expectedSourceHead) {
        throw failure('The source checkout moved after this review was loaded.', 'REVIEW_SOURCE_MOVED')
      }
      const patch = await this.command(
        executable,
        request.assignment.path,
        ['diff', '--binary', '--full-index', request.assignment.baseCommit, request.commit, '--'],
        signal,
      )
      if (patch.stdout.length === 0) throw failure('The reviewed Task commit has no patch to apply.', 'REVIEW_EMPTY')
      if (Buffer.byteLength(patch.stdout) > this.config.maxPatchBytes) {
        throw failure('The Task patch exceeds the configured Apply bound.', 'REVIEW_INCOMPLETE')
      }
      const preflight = await this.command(
        executable,
        request.assignment.sourcePath,
        ['apply', '--check', '--3way', '--index', '--whitespace=nowarn', '-'],
        signal,
        [0, 1, 128],
        patch.stdout,
      )
      if (preflight.exitCode !== 0) {
        throw failure('The Task patch conflicts with the current source checkout.', 'REVIEW_APPLY_CONFLICT')
      }
      const temporaryIndex = join(tmpdir(), `dsh-task-review-${randomUUID()}.index`)
      try {
        const env = { GIT_INDEX_FILE: temporaryIndex }
        await this.command(
          executable,
          request.assignment.sourcePath,
          ['read-tree', request.expectedSourceHead],
          signal,
          undefined,
          undefined,
          env,
        )
        const simulation = await this.command(
          executable,
          request.assignment.sourcePath,
          ['apply', '--3way', '--cached', '--whitespace=nowarn', '-'],
          signal,
          [0, 1, 128],
          patch.stdout,
          env,
        )
        if (simulation.exitCode !== 0) {
          throw failure('The Task patch conflicts with the current source checkout.', 'REVIEW_APPLY_CONFLICT')
        }
      } finally {
        await removeTemporaryIndex(temporaryIndex)
        await removeTemporaryIndex(`${temporaryIndex}.lock`)
      }
      const [confirmedHead, confirmedStatus] = await Promise.all([
        this.command(executable, request.assignment.sourcePath, ['rev-parse', '--verify', 'HEAD'], signal),
        this.command(
          executable,
          request.assignment.sourcePath,
          ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
          signal,
        ),
      ])
      if (confirmedHead.stdout.trim() !== request.expectedSourceHead) {
        throw failure('The source checkout moved during Apply preflight.', 'REVIEW_SOURCE_MOVED')
      }
      if (confirmedStatus.stdout.length > 0) {
        throw failure('The source checkout changed during Apply preflight.', 'REVIEW_SOURCE_DIRTY')
      }
      await this.command(
        executable,
        request.assignment.sourcePath,
        ['apply', '--3way', '--index', '--whitespace=nowarn', '-'],
        signal,
        undefined,
        patch.stdout,
      )
      const sourceHeadAfter = (
        await this.command(executable, request.assignment.sourcePath, ['rev-parse', '--verify', 'HEAD'], signal)
      ).stdout.trim()
      return Object.freeze({
        kind: 'apply' as const,
        operationId: TaskReviewOperationId(randomUUID()),
        taskId: request.assignment.taskId,
        workspaceId: request.assignment.workspaceId,
        reviewRevision: request.expectedRevision,
        commit: request.commit,
        sourceHeadBefore: request.expectedSourceHead,
        sourceHeadAfter,
        appliedAt: Date.now(),
      })
    })
  }

  async discard(request: DiscardTaskReviewRequest, signal?: AbortSignal): Promise<TaskDiscardReceipt> {
    return this.serialize(request.assignment.sourcePath, async () => {
      const reviewed = await this.state(request.assignment, signal)
      if (reviewed.summary.revision !== request.expectedRevision) {
        throw failure('The Task worktree changed after this review was loaded.', 'REVIEW_STALE')
      }
      if (reviewed.summary.truncated) {
        throw failure('The complete change set must be visible before it can be discarded.', 'REVIEW_INCOMPLETE')
      }
      const executable = await this.git(signal)
      const status = await this.command(
        executable,
        request.assignment.path,
        ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
        signal,
      )
      const uncommittedChangesDiscarded = status.stdout.length > 0
      if (uncommittedChangesDiscarded && !request.confirmedUncommittedLoss) {
        throw failure(
          'Discarding this worktree permanently removes uncommitted changes and requires confirmation.',
          'REVIEW_CONFIRMATION_REQUIRED',
        )
      }
      const recoverableCommit = reviewed.summary.headCommit === request.assignment.baseCommit
        ? undefined
        : reviewed.summary.headCommit
      await this.command(
        executable,
        request.assignment.sourcePath,
        [
          'worktree',
          'remove',
          ...uncommittedChangesDiscarded ? ['--force'] : [],
          request.assignment.path,
        ],
        signal,
      )
      try {
        await lstat(request.assignment.path)
        throw failure('Git reported success but left the Task worktree directory in place.', 'REVIEW_GIT_FAILED')
      } catch (error) {
        if (error instanceof TaskReviewError) throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw failure('The removed Task worktree could not be verified.', 'REVIEW_GIT_FAILED', error)
        }
      }
      const branch = await this.command(
        executable,
        request.assignment.sourcePath,
        ['show-ref', '--verify', '--quiet', `refs/heads/${request.assignment.branch}`],
        signal,
        [0, 1],
      )
      if (branch.exitCode !== 0) {
        throw failure('Git removed the Task branch while releasing its worktree.', 'REVIEW_GIT_FAILED')
      }
      return Object.freeze({
        kind: 'discard' as const,
        operationId: TaskReviewOperationId(randomUUID()),
        taskId: request.assignment.taskId,
        workspaceId: request.assignment.workspaceId,
        reviewRevision: request.expectedRevision,
        branch: request.assignment.branch,
        branchPreserved: true,
        worktreeRemoved: true,
        uncommittedChangesDiscarded,
        ...recoverableCommit === undefined ? {} : { recoverableCommit },
        discardedAt: Date.now(),
      })
    })
  }
}

export default LocalTaskReview
