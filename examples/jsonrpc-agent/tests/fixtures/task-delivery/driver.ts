/** Real SDK transport over Loader-composed Task services and Git; no model calls. */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as sdk from '@deepseek-ai/dsh-sdk-jsonrpc-server'
import { resolveConfig, runGit } from '@deepseek-ai/dsh-task-worktree-local'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('Task delivery SDK fixture requires a config path')
installFailLoud('sdk-task-delivery')
const ctx = await boot('sdk-task-delivery', resolveConfigPath(configPath, undefined))
const source = join(process.cwd(), 'source')
try {
  if (!existsSync(source)) {
    await mkdir(source)
    const limits = resolveConfig({ minFreeBytes: 0 })
    const executable = await ctx.subprocess.resolveExecutable('git')
    const git = (args: readonly string[]) => runGit(ctx.subprocess, executable, source, args, limits)
    await git(['init'])
    await git(['config', 'core.autocrlf', 'false'])
    await git(['config', 'user.name', 'SDK Delivery Fixture'])
    await git(['config', 'user.email', 'fixture@localhost'])
    await writeFile(join(source, 'tracked.txt'), 'base\n')
    await git(['add', '.'])
    await git(['commit', '-m', 'base'])
    const workspace = await ctx.workspaceRegistry.create(source)
    for (const label of ['delivered', 'unconfirmed', 'checkpoint', 'not-completed', 'discard-unconfirmed']) {
      const id = SessionId(label)
      const assignment = await ctx.taskWorktrees.create({ taskId: id, workspaceId: workspace.id, workspacePath: source })
      const session = ctx.sessions.create(id, { meta: { cwd: assignment.path } })
      session.append('task/worktree-assigned', { assignment })
      const defined = await ctx.tasks.define(id, {
        goal: `Deliver ${label}`, criteria: [{ text: 'Reviewed file' }], expectedSeq: session.seq,
      })
      const criterion = defined.definition?.criteria[0]
      if (criterion === undefined) throw new Error('SDK fixture has no acceptance criterion')
      await ctx.tasks.updateCriterion(id, { criterion: {
        ...criterion, status: 'waived',
      }, expectedSeq: session.seq })
      await ctx.tasks.review(id, { decision: 'ready', expectedSeq: session.seq })
      await writeFile(join(assignment.path, 'tracked.txt'), `${label}\n`)
      if (!await ctx.sessions.flush(session)) throw new Error('SDK fixture has no persistence participant')
    }
  }
  // Lose only a real completed Provider response; authorization and Git remain production code.
  const commit = ctx.taskReview.commit.bind(ctx.taskReview)
  ctx.taskReview.commit = async (request, signal) => {
    const result = await commit(request, signal)
    if (request.assignment.taskId === 'unconfirmed') throw new Error('Injected loss after real Git commit')
    return result
  }
  const discard = ctx.taskReview.discard.bind(ctx.taskReview)
  ctx.taskReview.discard = async (request, signal) => {
    const result = await discard(request, signal)
    if (request.assignment.taskId === 'discard-unconfirmed') throw new Error('Injected loss after real Git discard')
    return result
  }
  const startDelivery = ctx.tasks.startDelivery.bind(ctx.tasks)
  ctx.tasks.startDelivery = async (id, request) => {
    const result = await startDelivery(id, request)
    if (id === 'not-completed') throw new Error('Injected loss after authorization before Git')
    return result
  }
  const flush = ctx.sessions.flush.bind(ctx.sessions)
  let failedCheckpoint = false
  ctx.sessions.flush = async (session) => {
    if (session.id === 'checkpoint' && session.events.at(-1)?.type === 'task/review-committed' && !failedCheckpoint) {
      failedCheckpoint = true
      throw new Error('Injected receipt checkpoint failure')
    }
    return flush(session)
  }
  await ctx.plugin(sdk)
} catch (error) {
  await ctx.fiber.dispose()
  throw error
}
let exiting: Promise<void> | undefined
const exit = (code: number): void => {
  exiting ??= ctx.fiber.dispose().finally(() => { process.exit(code) })
}
process.stdin.on('end', () => { exit(0) })
process.on('SIGTERM', () => { exit(0) })
process.on('SIGINT', () => { exit(130) })
