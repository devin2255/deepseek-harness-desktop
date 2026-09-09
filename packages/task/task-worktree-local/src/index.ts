/** Local Git Provider for application-owned Task worktrees. @module @deepseek-ai/dsh-task-worktree-local */

import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, stat, statfs } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { TaskWorktreeError, TaskWorktreeService } from '@deepseek-ai/dsh-task-worktree'
import type {
  CreateTaskWorktreeRequest,
  TaskWorktreeAssignment,
  TaskWorktreeAvailability,
  TaskWorktreeErrorCode,
} from '@deepseek-ai/dsh-task-worktree'
import { ConfigSchema, resolveConfig } from './config.ts'
import type { Config, ResolvedConfig } from './config.ts'
import { GitCommandError, parseWorktreeList, runGit } from './git.ts'

export * from './config.ts'
export { parseWorktreeList } from './git.ts'

const COMMIT = /^[0-9a-f]{40}$/u

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function failure(message: string, code: TaskWorktreeErrorCode, cause?: unknown): TaskWorktreeError {
  return new TaskWorktreeError(message, code, cause === undefined ? undefined : { cause })
}

/** Local Provider using Git's own worktree registry as the live authority. */
export class LocalTaskWorktrees extends TaskWorktreeService {
  static inject = ['subprocess']
  static Config = ConfigSchema

  private readonly config: ResolvedConfig
  private readonly chains = new Map<string, Promise<void>>()
  private executable: Promise<string> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if ((ctx as Context & { subprocess?: unknown }).subprocess === undefined) {
      throw new Error('task-worktree-local requires ctx.subprocess')
    }
    this.config = resolveConfig(config)
  }

  private git(signal?: AbortSignal): Promise<string> {
    this.executable ??= this.ctx.subprocess.resolveExecutable(this.config.gitCommand, undefined, signal)
      .catch((error: unknown) => {
        this.executable = undefined
        throw failure(`Git executable ${JSON.stringify(this.config.gitCommand)} is unavailable.`, 'WORKTREE_UNAVAILABLE', error)
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
    return runGit(this.ctx.subprocess, executable, cwd, args, this.config, signal, acceptedExitCodes)
  }

  private async exclusive<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const preceding = this.chains.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => { release = resolveCurrent })
    const tail = preceding.then(() => current)
    this.chains.set(key, tail)
    await preceding
    try {
      return await operation()
    } finally {
      release()
      if (this.chains.get(key) === tail) this.chains.delete(key)
    }
  }

  async create(
    request: CreateTaskWorktreeRequest,
    signal?: AbortSignal,
  ): Promise<TaskWorktreeAssignment> {
    let sourcePath: string
    try {
      sourcePath = await realpath(request.workspacePath)
      if (!(await stat(sourcePath)).isDirectory()) throw new Error('not a directory')
    } catch (error) {
      throw failure('The selected Workspace is not an accessible Git repository directory.', 'WORKTREE_NOT_GIT', error)
    }
    return this.exclusive(sourcePath, async () => {
      const executable = await this.git(signal)
      let topLevel: string
      try {
        const result = await this.command(executable, sourcePath, ['rev-parse', '--show-toplevel'], signal)
        topLevel = await realpath(result.stdout.trim())
      } catch (error) {
        throw failure('The selected Workspace is not a Git repository root.', 'WORKTREE_NOT_GIT', error)
      }
      if (topLevel !== sourcePath) {
        throw failure('The selected Workspace must be the Git repository root.', 'WORKTREE_NOT_GIT')
      }
      const parent = dirname(sourcePath)
      if (parent !== sourcePath) {
        const parentProbe = await this.command(
          executable,
          parent,
          ['rev-parse', '--show-toplevel'],
          signal,
          [0, 128],
        )
        if (parentProbe.exitCode === 0 && await realpath(parentProbe.stdout.trim()) !== sourcePath) {
          throw failure(
            'A Git repository nested inside another checkout is not supported for isolated tasks.',
            'WORKTREE_NESTED_REPOSITORY',
          )
        }
      }
      const superproject = await this.command(
        executable, sourcePath, ['rev-parse', '--show-superproject-working-tree'], signal,
      )
      if (superproject.stdout.trim().length > 0) {
        throw failure('Git submodule workspaces are not supported for isolated tasks.', 'WORKTREE_NESTED_REPOSITORY')
      }
      let sourceHead: string
      try {
        sourceHead = (await this.command(executable, sourcePath, ['rev-parse', '--verify', 'HEAD'], signal)).stdout.trim()
      } catch (error) {
        throw failure('The Git repository has no committed HEAD to isolate.', 'WORKTREE_UNBORN_HEAD', error)
      }
      if (!COMMIT.test(sourceHead)) {
        throw failure('Git returned an invalid HEAD commit.', 'WORKTREE_GIT_FAILED')
      }
      const status = (await this.command(
        executable, sourcePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], signal,
      )).stdout

      await mkdir(this.config.home, { recursive: true })
      const filesystem = await statfs(this.config.home)
      const freeBytes = filesystem.bavail * filesystem.bsize
      if (!Number.isSafeInteger(freeBytes) || freeBytes < this.config.minFreeBytes) {
        throw failure(
          `The Harness-home volume has ${freeBytes} free bytes; ${this.config.minFreeBytes} are required.`,
          'WORKTREE_INSUFFICIENT_SPACE',
        )
      }

      const repositoryKey = digest(sourcePath).slice(0, 24)
      const taskKey = digest(request.taskId).slice(0, 24)
      const branch = `dsh/task-${taskKey}`
      const path = resolve(join(this.config.home, 'worktrees', 'v1', repositoryKey, taskKey))
      if (await exists(path)) {
        throw failure(`The managed worktree target already exists at ${path}.`, 'WORKTREE_TARGET_OCCUPIED')
      }
      const branchState = await this.command(
        executable,
        sourcePath,
        ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        signal,
        [0, 1],
      )
      if (branchState.exitCode === 0) {
        throw failure(`The managed branch ${branch} already exists.`, 'WORKTREE_BRANCH_OCCUPIED')
      }
      await mkdir(join(this.config.home, 'worktrees', 'v1', repositoryKey), { recursive: true })
      try {
        await this.command(executable, sourcePath, ['worktree', 'add', '-b', branch, path, sourceHead], signal)
      } catch (error) {
        const diagnostic = error instanceof GitCommandError ? error.message : 'Git could not create the worktree.'
        throw failure(`${diagnostic} Any partial directory or branch was preserved for recovery.`, 'WORKTREE_GIT_FAILED', error)
      }
      return Object.freeze({
        kind: 'git-worktree' as const,
        taskId: request.taskId,
        workspaceId: request.workspaceId,
        sourcePath,
        path: await realpath(path),
        branch,
        baseCommit: sourceHead,
        sourceHead,
        sourceDirty: status.length > 0,
        sourceStatusDigest: digest(status),
        createdAt: Date.now(),
      })
    })
  }

  async inspect(
    assignment: TaskWorktreeAssignment,
    signal?: AbortSignal,
  ): Promise<TaskWorktreeAvailability> {
    let worktreePath: string
    try {
      const status = await lstat(assignment.path)
      if (!status.isDirectory() || status.isSymbolicLink()) return 'diverged'
      worktreePath = await realpath(assignment.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
      return 'diverged'
    }
    let sourcePath: string
    try {
      sourcePath = await realpath(assignment.sourcePath)
    } catch {
      return 'diverged'
    }
    const executable = await this.git(signal)
    let records
    try {
      const output = await this.command(executable, sourcePath, ['worktree', 'list', '--porcelain', '-z'], signal)
      records = parseWorktreeList(output.stdout)
    } catch (error) {
      throw failure('Git could not inspect the recorded worktree.', 'WORKTREE_GIT_FAILED', error)
    }
    for (const record of records) {
      let recordPath: string
      try {
        recordPath = await realpath(record.path)
      } catch {
        continue
      }
      if (recordPath !== worktreePath) continue
      return record.head === assignment.baseCommit && record.branch === `refs/heads/${assignment.branch}`
        ? 'available'
        : 'diverged'
    }
    return 'diverged'
  }
}

export default LocalTaskWorktrees
