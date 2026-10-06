/** Real-Loader worktree inspection transcript over isolated Git repositories. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig, runGit } from '@deepseek-ai/dsh-task-worktree-local'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('worktree-inspection-driver requires a config path')

const uninstallFailLoud = installFailLoud('worktree-inspection-driver')
let ctx: Context | undefined
try {
  ctx = await boot('worktree-inspection-driver', resolveConfigPath(configPath, undefined))
  const runtime = ctx
  const limits = resolveConfig({ minFreeBytes: 0 })
  const executable = await runtime.subprocess.resolveExecutable('git')
  const git = async (cwd: string, args: readonly string[]) =>
    runGit(runtime.subprocess, executable, cwd, args, limits)
  const source = join(process.cwd(), 'source')
  await mkdir(source)
  await git(source, ['init'])
  await git(source, ['config', 'user.name', 'Worktree Fixture'])
  await git(source, ['config', 'user.email', 'fixture@localhost'])
  await writeFile(join(source, 'tracked.txt'), 'base\n')
  await git(source, ['add', 'tracked.txt'])
  await git(source, ['commit', '-m', 'base'])

  const assignment = await runtime.taskWorktrees.create({
    taskId: SessionId('committed-task'), workspaceId: WorkspaceId('workspace'), workspacePath: source,
  })
  const output = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
  output({ stage: 'created', availability: await runtime.taskWorktrees.inspect(assignment) })
  await writeFile(join(assignment.path, 'tracked.txt'), 'task change\n')
  await git(assignment.path, ['add', 'tracked.txt'])
  await git(assignment.path, ['commit', '-m', 'task change'])
  output({
    stage: 'committed',
    availability: await runtime.taskWorktrees.inspect(assignment),
    commitAdvanced: (await git(assignment.path, ['rev-parse', 'HEAD'])).stdout.trim() !== assignment.baseCommit,
    baseRetained: (await git(source, ['rev-parse', 'HEAD'])).stdout.trim() === assignment.baseCommit,
    sourceUnchanged: (await readFile(join(source, 'tracked.txt'), 'utf8')).replaceAll('\r\n', '\n') === 'base\n'
      && (await git(source, ['status', '--porcelain=v1'])).stdout === '',
  })
  await git(assignment.path, ['switch', '--detach'])
  output({ stage: 'detached', availability: await runtime.taskWorktrees.inspect(assignment) })

  const unrelated = await runtime.taskWorktrees.create({
    taskId: SessionId('unrelated-task'), workspaceId: WorkspaceId('workspace'), workspacePath: source,
  })
  await git(unrelated.path, ['commit', '--amend', '-m', 'unrelated root'])
  output({
    stage: 'unrelated-history',
    branchRetained: (await git(unrelated.path, ['branch', '--show-current'])).stdout.trim() === unrelated.branch,
    availability: await runtime.taskWorktrees.inspect(unrelated),
  })
} catch (error: unknown) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
