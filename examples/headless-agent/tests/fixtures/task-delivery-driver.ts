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
import { createUserMessage } from '@deepseek-ai/dsh-llm'

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

  const completedDiscards: { taskId: SessionId; headCommit: string; commit: string }[] = []
  for (const mode of ['cold', 'resident'] as const) {
    const { assignment, handle } = mode === 'cold' ? { assignment: cold, handle: undefined } : await prepare('resident-root', true)
    const blocked: string[] = []
    const durable: string[] = []
    const metadataBlocked: string[] = []
    let interleavedInput = false
    const review = await runtime.taskReview.summarize({ assignment })
    let commit = ''
    let committedRevision = review.revision
    let discardHead = ''
    for (const method of ['commit', 'apply', 'discard'] as const) {
      if (method === 'discard') {
        if (mode === 'resident') {
          await writeFile(join(assignment.path, 'follow-up.txt'), 'recoverable follow-up\n')
          await git(assignment.path, ['add', 'follow-up.txt'])
          await git(assignment.path, ['commit', '-m', 'Follow-up commit'])
        }
        await writeFile(join(assignment.path, 'tracked.txt'), 'uncommitted follow-up\n')
        const currentReview = await runtime.taskReview.summarize({ assignment })
        if (currentReview.revision === committedRevision) throw new Error('Discard needs the later review revision')
        committedRevision = currentReview.revision
        discardHead = currentReview.headCommit
      }
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
            confirmedUncommittedLoss: true, expectedSeq })
      try {
        await Promise.race([entered.promise, pending.then(() => { throw new Error(`${method} did not reach its real Provider result`) })])
        const stored = await runtime.sessionPersistence.inspect(assignment.taskId)
        const start = stored.events.at(-1)
        if (start?.type !== 'task/delivery-started' || start.data.intent.kind !== method) {
          throw new Error('Git began without a durable delivery intent')
        }
        if (start.data.intent.kind === 'commit') {
          const target = (await git(assignment.path, ['show', '--no-patch', '--format=%P%n%T', 'HEAD'])).stdout.trim()
          if (target !== `${start.data.intent.headCommit}\n${start.data.intent.tree}`) {
            throw new Error('Commit did not retain its exact parent and Git tree before publishing the result')
          }
        }
        if (start.data.intent.kind === 'discard' && (start.data.intent.headCommit !== discardHead
          || !start.data.intent.uncommittedChanges || !start.data.intent.confirmedUncommittedLoss)) {
          throw new Error('Discard did not retain current recovery facts before removing the worktree')
        }
        durable.push(method)
        try {
          await runtime.tasks.review(assignment.taskId, { decision: 'changes-requested', expectedSeq: current(assignment.taskId).asOfSeq })
          throw new Error('Task metadata changed during delivery')
        } catch (error: unknown) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'TASK_DELIVERY_PENDING') throw error
        }
        metadataBlocked.push(method)
        if (handle === undefined) {
          try {
            const unexpected = await runtime.agents.resume({ resumeSessionId: assignment.taskId })
            await unexpected.dispose()
            throw new Error('Cold root activated during delivery')
          } catch (error: unknown) {
            if (!(error instanceof AgentOfflineReservationError)) throw error
          }
        } else {
          handle.agent.inject(createUserMessage({
            content: [{ type: 'text', text: `Context queued during ${method}` }], source: { kind: 'user' },
          }))
          interleavedInput = true
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
    const branchRetained = (await git(source, ['rev-parse', assignment.branch])).stdout.trim() === discardHead
    if (row.discardReceipt?.recoverableCommit !== discardHead || !row.discardReceipt.uncommittedChangesDiscarded) {
      throw new Error('Discard receipt lost the authorized recovery facts')
    }
    completedDiscards.push({ taskId: assignment.taskId, headCommit: discardHead, commit })
    const sourceHeadPreserved = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim() === assignment.sourceHead
    const sourceContentApplied = await readFile(join(source, 'tracked.txt'), 'utf8') === `${mode}-root\n`
    await handle?.dispose()
    const resumed = await runtime.agents.resume({ resumeSessionId: assignment.taskId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    await resumed.dispose()
    process.stdout.write(`${JSON.stringify({ stage: mode, blocked, durable, metadataBlocked, interleavedInput,
      commitTargetPersisted: true,
      receipts: [row.commitReceipt?.kind, row.applyReceipt?.kind, row.discardReceipt?.kind],
      discard: { currentReviewUsed: true, currentHeadRetained: true, headAdvanced: discardHead !== commit,
        uncommittedLoss: true, preflightPersisted: true },
      branchRetained, sourceHeadPreserved, sourceContentApplied, reservationReleased: runtime.agents.get(assignment.taskId) === undefined })}\n`)
    await git(source, ['commit', '-m', `Adopt ${mode}`])
  }
  const { assignment, handle } = await prepare('unconfirmed-root', true)
  if (handle === undefined) throw new Error('Unconfirmed delivery needs a resident Agent')
  const reviewed = await runtime.taskReview.summarize({ assignment })
  const originalCommit = runtime.taskReview.commit.bind(runtime.taskReview)
  let committed = ''
  runtime.taskReview.commit = async (request, signal) => {
    committed = (await originalCommit(request, signal)).commit
    throw new Error('Injected result loss after Git commit')
  }
  let executionBlocked = false
  try {
    const response = await api.tasks.commit({ sessionId: assignment.taskId, expectedRevision: reviewed.revision,
      message: 'Interrupted delivery', expectedSeq: current(assignment.taskId).asOfSeq })
    if (response.result.ok || response.result.error.code !== 'task-delivery-pending') throw new Error('Missing unconfirmed delivery error')
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'Do not execute while delivery is unconfirmed' }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    executionBlocked = !handle.agent.session.events.some(event => event.type === 'request/header')
      && handle.agent.session.events.some(event => event.type === 'turn/end' && event.data.reason.kind === 'error')
  } finally {
    runtime.taskReview.commit = originalCommit
    await handle.dispose()
  }
  await runtime.fiber.dispose()
  ctx = await boot('task-delivery-unconfirmed-replay', resolveConfigPath(configPath, undefined))
  for (const discard of completedDiscards) {
    const restored = ctx.tasks.snapshot().tasks.find(task => task.taskId === discard.taskId)
    if (restored?.commitReceipt?.commit !== discard.commit || restored.discardReceipt?.recoverableCommit !== discard.headCommit
      || !restored.discardReceipt.uncommittedChangesDiscarded || restored.attention.some(item => item.kind === 'delivery-unconfirmed')) {
      throw new Error('Cold replay did not restore the later discard independently from the original commit')
    }
  }
  process.stdout.write(`${JSON.stringify({ stage: 'discard-replay', originalCommitRetained: true, currentRecoveryRetained: true,
    uncommittedLossRetained: true, noUnconfirmedAttention: true })}\n`)
  const replayed = ctx.tasks.snapshot().tasks.find(task => task.taskId === assignment.taskId)
  const stored = await ctx.sessionPersistence.inspect(assignment.taskId)
  const intentRetained = stored.events.filter(event => event.type === 'task/delivery-started').length === 1
    && replayed?.attention.some(item => item.kind === 'delivery-unconfirmed') === true
  const lostIntent = stored.events.find(event => event.type === 'task/delivery-started')
  const committedTarget = (await git(source, ['show', '--no-patch', '--format=%P%n%T', committed])).stdout.trim()
  if (lostIntent?.type !== 'task/delivery-started' || lostIntent.data.intent.kind !== 'commit'
    || committedTarget !== `${lostIntent.data.intent.headCommit}\n${lostIntent.data.intent.tree}`) {
    throw new Error('Cold unconfirmed commit lost its authorized parent and tree')
  }
  const retryApi = new InProcessApiClient(toFetchHandler(createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }), cwd: source,
  })))
  const retried = await retryApi.tasks.commit({ sessionId: assignment.taskId, expectedRevision: reviewed.revision,
    message: 'Must not repeat', expectedSeq: replayed?.asOfSeq ?? 0 })
  process.stdout.write(`${JSON.stringify({ stage: 'unconfirmed', intentRetained, executionBlocked,
    commitTargetRetained: true,
    receiptAbsent: replayed?.commitReceipt === undefined, retryRejected: !retried.result.ok,
    gitCommitExists: (await git(source, ['rev-parse', assignment.branch])).stdout.trim() === committed })}\n`)
  const beforeInspection = JSON.stringify(stored.events)
  const taskIndexPath = (await git(assignment.path, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim()
  const sourceIndexPath = (await git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])).stdout.trim()
  const [taskIndex, sourceIndex] = await Promise.all([readFile(taskIndexPath), readFile(sourceIndexPath)])
  const inspected = await retryApi.tasks.inspectDelivery({ sessionId: assignment.taskId, operationId: lostIntent.data.intent.operationId })
  if (!inspected.result.ok || inspected.result.value.status !== 'completed'
    || inspected.result.value.effect.kind !== 'commit' || inspected.result.value.effect.commit !== committed
    || inspected.result.value.effect.tree !== lostIntent.data.intent.tree
    || inspected.result.value.effect.headBefore !== lostIntent.data.intent.headCommit) {
    throw new Error('Cold inspection did not match the exact authorized commit')
  }
  if (!(await readFile(taskIndexPath)).equals(taskIndex) || !(await readFile(sourceIndexPath)).equals(sourceIndex)
    || JSON.stringify((await ctx.sessionPersistence.inspect(assignment.taskId)).events) !== beforeInspection
    || ctx.agents.get(assignment.taskId) !== undefined || ctx.sessions.get(assignment.taskId) !== undefined) {
    throw new Error('Delivery inspection changed Git, history, or cold ownership')
  }
  const originalContent = await readFile(join(assignment.path, 'tracked.txt'))
  await writeFile(join(assignment.path, 'tracked.txt'), 'Modified after lost receipt\n')
  const changed = await retryApi.tasks.inspectDelivery({ sessionId: assignment.taskId, operationId: lostIntent.data.intent.operationId })
  if (!changed.result.ok || changed.result.value.status !== 'ambiguous' || changed.result.value.reason !== 'task-changed') {
    throw new Error('Changed worktree was accepted as a completed delivery')
  }
  await writeFile(join(assignment.path, 'tracked.txt'), originalContent)
  process.stdout.write(`${JSON.stringify({ stage: 'inspection', completedCommitObserved: true, changedTreeAmbiguous: true,
    noExecutionTime: !('committedAt' in inspected.result.value.effect), userIndexesUnchanged: true,
    historyUnchanged: true, rootStillCold: true,
    uncertaintyRetained: ctx.tasks.snapshot().tasks.find(task => task.taskId === assignment.taskId)
      ?.attention.some(item => item.kind === 'delivery-unconfirmed') === true })}\n`)
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
