/** Real Loader, Agent maintenance, cold replay, and Git-backed root delivery. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AgentOfflineReservationError, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { createApiProxy, InProcessApiClient, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig, runGit } from '@deepseek-ai/dsh-task-worktree-local'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type { TaskSnapshot } from '@deepseek-ai/dsh-task'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('task-delivery-driver requires a config path')
const uninstallFailLoud = installFailLoud('task-delivery-driver')
let ctx: Context | undefined
try {
  ctx = await boot('task-delivery-driver', resolveConfigPath(configPath, undefined))
  const source = join(process.cwd(), 'source')
  await mkdir(source)
  const limits = resolveConfig({ minFreeBytes: 0 })
  const executable = await ctx.subprocess.resolveExecutable('git')
  const git = async (cwd: string, args: readonly string[]) => runGit(ctx!.subprocess, executable, cwd, args, limits)
  await git(source, ['init'])
  await git(source, ['config', 'core.autocrlf', 'false'])
  await git(source, ['config', 'user.name', 'Delivery Fixture'])
  await git(source, ['config', 'user.email', 'fixture@localhost'])
  await writeFile(join(source, 'tracked.txt'), 'base\n')
  await git(source, ['add', '.'])
  await git(source, ['commit', '-m', 'base'])
  const workspace = await ctx.workspaceRegistry.create(source)

  const prepare = async (
    label: string, resident: boolean,
  ): Promise<{ assignment: TaskWorktreeAssignment; handle: AgentHandle | undefined }> => {
    const taskId = SessionId(label)
    const assignment = await ctx!.taskWorktrees.create({ taskId, workspaceId: workspace.id, workspacePath: source })
    const handle = resident ? await ctx!.agents.create({ sessionId: taskId, meta: { cwd: assignment.path },
      agentOptions: { provider: 'fixture', model: 'fixture' },
    }) : undefined
    const session = handle?.agent.session ?? ctx!.sessions.create(taskId, { meta: { cwd: assignment.path } })
    session.append('task/worktree-assigned', { assignment })
    const definitionSeq = session.seq
    const defined = await ctx!.tasks.define(taskId, {
      goal: `Deliver ${label}`, criteria: [{ text: 'File reviewed' }], expectedSeq: session.seq,
    })
    const criterion = defined.definition?.criteria[0]
    if (criterion === undefined) throw new Error('Task definition has no criterion')
    await ctx!.tasks.updateCriterion(taskId, { criterion: {
      ...criterion, status: 'satisfied', evidence: [{ sessionId: taskId, seq: definitionSeq }],
    }, expectedSeq: session.seq })
    await ctx!.tasks.review(taskId, { decision: 'ready', expectedSeq: session.seq })
    await writeFile(join(assignment.path, 'tracked.txt'), `${label}\n`)
    await ctx!.sessions.flush(session)
    return { assignment, handle }
  }
  const { assignment: cold } = await prepare('cold-root', false)
  await ctx.fiber.dispose()
  ctx = await boot('task-delivery-cold-replay', resolveConfigPath(configPath, undefined))
  const runtime = ctx
  const api = new InProcessApiClient(toFetchHandler(createApiProxy(runtime, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: source,
  })))
  const current = (id: SessionId): TaskSnapshot => {
    const row = runtime.tasks.snapshot().tasks.find(task => task.taskId === id)
    if (row === undefined) throw new Error('Delivery Task is unavailable')
    return row
  }
  if (runtime.sessions.get(cold.taskId) !== undefined || runtime.agents.get(cold.taskId) !== undefined) {
    throw new Error('Offline delivery must start from an unattached cold Session')
  }

  for (const mode of ['cold', 'resident'] as const) {
    const { assignment, handle } = mode === 'cold' ? { assignment: cold, handle: undefined } : await prepare('resident-root', true)
    const blocked: string[] = []
    const review = await runtime.taskReview.summarize({ assignment })
    let commit = ''
    let committedRevision = review.revision
    for (const method of ['commit', 'apply', 'discard'] as const) {
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      // A timing fence delays a real Provider result; Git execution and receipt values stay real.
      const hold = async <T>(operation: Promise<T>): Promise<T> => {
        const result = await operation
        entered.resolve(undefined)
        await release.promise
        return result
      }
      const originalCommit = runtime.taskReview.commit.bind(runtime.taskReview)
      const originalApply = runtime.taskReview.apply.bind(runtime.taskReview)
      const originalDiscard = runtime.taskReview.discard.bind(runtime.taskReview)
      if (method === 'commit') runtime.taskReview.commit = (request, signal) => hold(originalCommit(request, signal))
      if (method === 'apply') runtime.taskReview.apply = (request, signal) => hold(originalApply(request, signal))
      if (method === 'discard') runtime.taskReview.discard = (request, signal) => hold(originalDiscard(request, signal))
      const expectedSeq = current(assignment.taskId).asOfSeq
      const pending = method === 'commit'
        ? api.tasks.commit({ sessionId: assignment.taskId, expectedRevision: review.revision, message: `Deliver ${mode}`, expectedSeq })
        : method === 'apply'
          ? api.tasks.apply({ sessionId: assignment.taskId, expectedRevision: committedRevision,
            expectedSourceHead: assignment.sourceHead, commit, expectedSeq })
          : api.tasks.discard({ sessionId: assignment.taskId, expectedRevision: committedRevision,
            confirmedUncommittedLoss: false, expectedSeq })
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error(`${method} did not reach its real Provider result`) })])
        if (handle === undefined) {
          try {
            const unexpected = await runtime.agents.resume({ resumeSessionId: assignment.taskId })
            await unexpected.dispose()
            throw new Error('Cold root activated during delivery')
          } catch (error: unknown) {
            if (!(error instanceof AgentOfflineReservationError)) throw error
          }
        } else {
          let rejected = false
          try { await handle.agent.runMaintenance(() => Promise.resolve()) } catch { rejected = true }
          if (!rejected) throw new Error('Resident root admitted competing maintenance')
        }
        blocked.push(method)
      } finally {
        release.resolve(undefined)
        runtime.taskReview.commit = originalCommit
        runtime.taskReview.apply = originalApply
        runtime.taskReview.discard = originalDiscard
      }
      const response = await pending
      if (!response.result.ok) throw new Error(response.result.error.message)
      const recorded = current(assignment.taskId).commitReceipt
      if (recorded === undefined) throw new Error('Commit receipt is unavailable')
      commit = recorded.commit
      committedRevision = recorded.committedRevision
    }
    const row = current(assignment.taskId)
    const branchRetained = (await git(source, ['rev-parse', assignment.branch])).stdout.trim() === commit
    const sourceHeadPreserved = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim() === assignment.sourceHead
    const sourceContentApplied = await readFile(join(source, 'tracked.txt'), 'utf8') === `${mode}-root\n`
    await handle?.dispose()
    const resumed = await runtime.agents.resume({ resumeSessionId: assignment.taskId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    await resumed.dispose()
    process.stdout.write(`${JSON.stringify({ stage: mode, blocked, receipts: [row.commitReceipt?.kind, row.applyReceipt?.kind, row.discardReceipt?.kind],
      branchRetained, sourceHeadPreserved, sourceContentApplied, reservationReleased: runtime.agents.get(assignment.taskId) === undefined })}\n`)
    await git(source, ['commit', '-m', `Adopt ${mode}`])
  }
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
