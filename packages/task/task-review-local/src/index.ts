/** Local Git Provider for Task review and delivery. @module @deepseek-ai/dsh-task-review-local */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readlink, realpath } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  TaskReviewError,
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
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_MAX_DIFF_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TERMINATE_GRACE_MS,
} from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { parseNameStatus, parseNumstat, parseWorktreeList, runGit } from './git.ts'

export * from './config.ts'
export { parseNameStatus, parseNumstat, parseWorktreeList } from './git.ts'

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
  if (gitCommand.trim().length === 0 || gitCommand !== gitCommand.trim()) {
    throw new Error('task-review-local: gitCommand must be non-empty and normalized')
  }
  if (maxDiffBytes > maxOutputBytes) {
    throw new Error('task-review-local: maxDiffBytes must not exceed maxOutputBytes')
  }
  return Object.freeze({
    gitCommand,
    commandTimeoutMs: config.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
    terminateGraceMs: config.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS,
    maxOutputBytes,
    maxDiffBytes,
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

interface UntrackedInspection {
  readonly binary: boolean
  readonly additions: number | null
  readonly digest: string
}

async function inspectUntracked(path: string, signal?: AbortSignal): Promise<UntrackedInspection> {
  const metadata = await lstat(path)
  const hash = createHash('sha256')
  if (metadata.isSymbolicLink()) {
    const target = await readlink(path)
    hash.update('symlink\0').update(target)
    return { binary: false, additions: 1, digest: hash.digest('hex') }
  }
  if (!metadata.isFile()) {
    hash.update(`special\0${metadata.mode}\0${metadata.size}`)
    return { binary: true, additions: null, digest: hash.digest('hex') }
  }
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

/** Local Provider that treats Git and worktree contents as request-time authority. */
export class LocalTaskReview extends TaskReviewService {
  static inject = ['subprocess']
  static Config = Config

  private readonly config: ResolvedConfig
  private executable: Promise<string> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
  }

  private git(signal?: AbortSignal): Promise<string> {
    this.executable ??= this.ctx.subprocess.resolveExecutable(this.config.gitCommand, undefined, signal)
      .catch((error: unknown) => {
        this.executable = undefined
        throw failure(`Git executable ${JSON.stringify(this.config.gitCommand)} is unavailable.`, 'REVIEW_GIT_FAILED', error)
      })
    return this.executable
  }

  private async command(
    executable: string,
    cwd: string,
    args: readonly string[],
    signal?: AbortSignal,
    acceptedExitCodes?: readonly number[],
  ) {
    try {
      return await runGit(this.ctx.subprocess, executable, cwd, args, this.config, signal, acceptedExitCodes)
    } catch (error) {
      if (signal?.aborted === true) throw error
      if (error instanceof TaskReviewError) throw error
      throw failure('Git could not inspect the Task worktree.', 'REVIEW_GIT_FAILED', error)
    }
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
  ): Promise<string> {
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
    const head = (await this.command(executable, worktreePath, ['rev-parse', '--verify', 'HEAD'], signal)).stdout.trim()
    if (!COMMIT.test(head)) throw failure('Git returned an invalid Task worktree HEAD.', 'REVIEW_GIT_FAILED')
    const ancestry = await this.command(
      executable,
      worktreePath,
      ['merge-base', '--is-ancestor', assignment.baseCommit, head],
      signal,
      [0, 1],
    )
    if (ancestry.exitCode !== 0) {
      throw failure('The Task worktree no longer descends from its recorded base.', 'REVIEW_WORKTREE_DIVERGED')
    }
    return head
  }

  private async state(assignment: TaskWorktreeAssignment, signal?: AbortSignal): Promise<ReviewState> {
    signal?.throwIfAborted()
    const worktreePath = await this.worktreePath(assignment)
    const executable = await this.git(signal)
    const headCommit = await this.validateAssignment(executable, assignment, worktreePath, signal)
    const [names, numstat, untracked, trackedPatch] = await Promise.all([
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
      this.command(
        executable,
        worktreePath,
        ['diff', '--binary', '--full-index', '--find-renames=50%', assignment.baseCommit, '--'],
        signal,
      ),
    ])
    const counts = new Map(parseNumstat(numstat.stdout).map(value => [value.path, value]))
    const files: TaskReviewFile[] = parseNameStatus(names.stdout).map((change) => {
      const values = counts.get(change.path)
      if (values === undefined) throw failure('Git omitted line counts for a changed file.', 'REVIEW_GIT_FAILED')
      return Object.freeze({
        ...change,
        binary: values.additions === null || values.deletions === null,
        additions: values.additions,
        deletions: values.deletions,
      })
    })
    const revisionHash = createHash('sha256')
      .update(`${assignment.taskId}\0${assignment.workspaceId}\0${assignment.baseCommit}\0${headCommit}\0`)
      .update(names.stdout)
      .update(numstat.stdout)
      .update(trackedPatch.stdout)
    for (const path of untracked.stdout.split('\0').filter(Boolean).sort(lexicalCompare)) {
      if (!validReviewPath(path)) throw failure('Git returned an invalid untracked path.', 'REVIEW_GIT_FAILED')
      const absolutePath = resolve(worktreePath, ...path.split('/'))
      if (absolutePath !== worktreePath && !absolutePath.startsWith(`${worktreePath}${sep}`)) {
        throw failure('Git returned an untracked path outside the Task worktree.', 'REVIEW_GIT_FAILED')
      }
      const inspected = await inspectUntracked(absolutePath, signal)
      revisionHash.update(`untracked\0${path}\0${inspected.digest}\0`)
      files.push(Object.freeze({
        path,
        status: 'untracked' as const,
        binary: inspected.binary,
        additions: inspected.additions,
        deletions: inspected.binary ? null : 0,
      }))
    }
    files.sort((left, right) => lexicalCompare(left.path, right.path))
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

  async commit(_request: CommitTaskReviewRequest, _signal?: AbortSignal): Promise<TaskCommitReceipt> {
    throw failure('Task review commit is not available from this Provider.', 'REVIEW_GIT_FAILED')
  }

  async apply(_request: ApplyTaskReviewRequest, _signal?: AbortSignal): Promise<TaskApplyReceipt> {
    throw failure('Task review apply is not available from this Provider.', 'REVIEW_GIT_FAILED')
  }

  async discard(_request: DiscardTaskReviewRequest, _signal?: AbortSignal): Promise<TaskDiscardReceipt> {
    throw failure('Task review discard is not available from this Provider.', 'REVIEW_GIT_FAILED')
  }
}

export default LocalTaskReview
