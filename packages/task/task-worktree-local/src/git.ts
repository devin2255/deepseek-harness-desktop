/** Bounded managed Git execution and porcelain parsing for Task worktrees. */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
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
 * Execute Git without a shell and reject truncated output before parsing it.
 * @param subprocess - Managed process-tree Provider.
 * @param executable - Canonical Git executable.
 * @param cwd - Repository or candidate directory.
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
  const exitCode = outcome.exitCode
  if (exitCode === null) throw new Error(`Git terminated by ${outcome.signal ?? 'an unknown signal'}`)
  const result = { exitCode, stdout: stdout.text, stderr: stderr.text }
  if (!acceptedExitCodes.includes(exitCode)) throw new GitCommandError(result)
  return result
}

/** One record from `git worktree list --porcelain -z`. */
export interface GitWorktreeRecord {
  readonly path: string
  readonly head?: string
  readonly branch?: string
}

/**
 * Parse NUL-delimited worktree records without path quoting.
 * @param output - Complete stdout from `git worktree list --porcelain -z`.
 * @returns Records carrying only fields required for identity checks.
 */
export function parseWorktreeList(output: string): readonly GitWorktreeRecord[] {
  return output.split('\0\0').filter(record => record.length > 0).map((record) => {
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
