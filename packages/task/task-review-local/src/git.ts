/** Bounded managed Git execution and porcelain parsing for local Task review. */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { TaskReviewFileStatus } from '@deepseek-ai/dsh-task-review'
import type { ResolvedConfig } from './config.ts'

/** Settled bounded Git output. */
export interface GitResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

/** Internal Git failure retaining bounded diagnostics. */
export class GitCommandError extends Error {
  /** Non-success exit and bounded output returned by the managed process. */
  readonly result: GitResult

  /** @param result - Non-success exit and bounded output. */
  constructor(result: GitResult) {
    super(`Git exited with code ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || 'no diagnostics'}`)
    this.name = 'GitCommandError'
    this.result = result
  }
}

/**
 * Execute Git without a shell and reject incomplete collected output.
 * @param subprocess - Managed process-tree Provider.
 * @param executable - Canonical Git executable.
 * @param cwd - Repository directory.
 * @param args - Git arguments after the executable.
 * @param config - Output, deadline, and termination limits.
 * @param signal - Optional caller cancellation.
 * @param acceptedExitCodes - Exit codes returned instead of rejected.
 * @returns Complete bounded output and exit code.
 */
export async function runGit(
  subprocess: SubprocessRuntime,
  executable: string,
  cwd: string,
  args: readonly string[],
  config: ResolvedConfig,
  signal?: AbortSignal,
  acceptedExitCodes: readonly number[] = [0],
): Promise<GitResult> {
  signal?.throwIfAborted()
  const deadline = AbortSignal.timeout(config.commandTimeoutMs)
  const processSignal = signal === undefined ? deadline : AbortSignal.any([signal, deadline])
  const handle = subprocess.spawn({
    argv: [executable, '-c', 'core.quotePath=false', ...args],
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: config.maxOutputBytes },
      stderr: { maxBytes: config.maxOutputBytes },
    },
    graceMs: config.terminateGraceMs,
    signal: processSignal,
  })
  const outcome = await handle.done
  signal?.throwIfAborted()
  if (deadline.aborted) throw new Error(`Git command exceeded ${config.commandTimeoutMs} ms`)
  const stdout = handle.collected.stdout?.readFrom(0)
  const stderr = handle.collected.stderr?.readFrom(0)
  if (stdout === undefined || stderr === undefined || stdout.lossy || stderr.lossy) {
    throw new Error('Git output exceeded the configured validation bound')
  }
  if (outcome.exitCode === null) throw new Error(`Git terminated by ${outcome.signal ?? 'an unknown signal'}`)
  const result = { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text }
  if (!acceptedExitCodes.includes(outcome.exitCode)) throw new GitCommandError(result)
  return result
}

/** One record from `git worktree list --porcelain -z`. */
export interface GitWorktreeRecord {
  readonly path: string
  readonly head?: string
  readonly branch?: string
}

/**
 * Parse NUL-delimited worktree records.
 * @param output - Complete porcelain output.
 * @returns Records carrying fields needed for assignment validation.
 */
export function parseWorktreeList(output: string): readonly GitWorktreeRecord[] {
  return output.split('\0\0').filter(Boolean).map((record) => {
    let path: string | undefined
    let head: string | undefined
    let branch: string | undefined
    for (const field of record.split('\0').filter(Boolean)) {
      const separator = field.indexOf(' ')
      const name = separator < 0 ? field : field.slice(0, separator)
      const value = separator < 0 ? '' : field.slice(separator + 1)
      if (name === 'worktree') path = value
      else if (name === 'HEAD') head = value
      else if (name === 'branch') branch = value
    }
    if (path === undefined || path.length === 0) throw new Error('Git worktree record has no path')
    return { path, ...head === undefined ? {} : { head }, ...branch === undefined ? {} : { branch } }
  })
}

/** Parsed tracked-file state from `git diff --name-status -z`. */
export interface GitChangedPath {
  readonly path: string
  readonly previousPath?: string
  readonly status: TaskReviewFileStatus
}

function reviewStatus(code: string): TaskReviewFileStatus {
  if (code.startsWith('A')) return 'added'
  if (code.startsWith('M')) return 'modified'
  if (code.startsWith('D')) return 'deleted'
  if (code.startsWith('R')) return 'renamed'
  if (code.startsWith('C')) return 'copied'
  if (code.startsWith('T')) return 'type-changed'
  if (code.startsWith('U')) return 'conflicted'
  throw new Error(`Unsupported Git file status ${JSON.stringify(code)}`)
}

/**
 * Parse NUL-delimited tracked file changes.
 * @param output - Complete name-status output.
 * @returns Normalized review paths.
 */
export function parseNameStatus(output: string): readonly GitChangedPath[] {
  const fields = output.split('\0')
  const changes: GitChangedPath[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]
    if (code === undefined || code.length === 0) continue
    const status = reviewStatus(code)
    if (status === 'renamed' || status === 'copied') {
      const previousPath = fields[index++]
      const path = fields[index++]
      if (!previousPath || !path) throw new Error('Git rename record is incomplete')
      changes.push({ path, previousPath, status })
    } else {
      const path = fields[index++]
      if (!path) throw new Error('Git file-status record is incomplete')
      changes.push({ path, status })
    }
  }
  return changes
}

/** Per-file line counts from `git diff --numstat -z`. */
export interface GitNumstat {
  readonly path: string
  readonly additions: number | null
  readonly deletions: number | null
}

function count(value: string): number | null {
  if (value === '-') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Git numstat count is invalid')
  return parsed
}

/**
 * Parse NUL-delimited numstat output, including rename records.
 * @param output - Complete numstat output.
 * @returns Counts keyed by each change's resulting path.
 */
export function parseNumstat(output: string): readonly GitNumstat[] {
  const fields = output.split('\0')
  const results: GitNumstat[] = []
  for (let index = 0; index < fields.length;) {
    const field = fields[index++]
    if (field === undefined || field.length === 0) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) throw new Error('Git numstat record is incomplete')
    const additions = count(field.slice(0, firstTab))
    const deletions = count(field.slice(firstTab + 1, secondTab))
    let path = field.slice(secondTab + 1)
    if (path.length === 0) {
      const previousPath = fields[index++]
      const resultingPath = fields[index++]
      if (!previousPath || !resultingPath) throw new Error('Git rename numstat record is incomplete')
      path = resultingPath
    }
    results.push({ path, additions, deletions })
  }
  return results
}
