/** Real TypeScript SDK delivery journal, Git effects, and cold uncertainty. */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import { DeepSeekHarness, type TaskSnapshot } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const fixture = fileURLToPath(new URL('./fixtures/task-delivery/', import.meta.url))
const expected = fileURLToPath(new URL('./snapshots/task-delivery/result.expected.json', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('projects authorized delivery and preserves lost results through the TypeScript SDK', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-sdk-delivery-'))
  const launch = resolveExampleLaunch({ srcBin: join(fixture, 'driver.ts'), libBin: join(fixture, 'driver.ts'),
    configArgs: [join(fixture, 'cordis.yml')], tsconfigPath })
  const create = () => new DeepSeekHarness({ launch: { ...launch, cwd,
    env: { ...process.env, ...launch.env, DSH_HOME: join(cwd, '.dsh'), DSH_AGENTS_HOME: join(cwd, '.agents') },
    requestTimeoutMs: 30_000,
  } })
  const git = (args: string[]) => execFileSync('git', args, { cwd: join(cwd, 'source'), encoding: 'utf8' }).trim()
  let harness = create()
  try {
    await harness.start()
    const events: SessionEvent[] = []
    const subscription = harness.client.subscribe()
    const row = (id: string, tasks: readonly TaskSnapshot[]) => {
      const found = tasks.find(task => task.taskId === id)
      if (found === undefined) throw new Error(`SDK has no Task ${id}`)
      return found
    }
    const initial = row('delivered', (await harness.listTasks()).tasks)
    const summary = await harness.getTaskReviewSummary('delivered')
    const committed = await harness.commitTask('delivered', {
      expectedRevision: summary.revision, expectedSeq: initial.asOfSeq, message: 'SDK delivery',
    })
    const receipt = committed.commitReceipt
    if (receipt === undefined) throw new Error('SDK did not return commit receipt')
    const applied = await harness.applyTask('delivered', { expectedRevision: receipt.committedRevision,
      expectedSourceHead: summary.sourceHead, commit: receipt.commit, expectedSeq: committed.asOfSeq })
    const discarded = await harness.discardTask('delivered', { expectedRevision: receipt.committedRevision,
      expectedSeq: applied.asOfSeq, confirmedUncommittedLoss: false })
    const checkpointBefore = row('checkpoint', (await harness.listTasks()).tasks)
    const checkpointSummary = await harness.getTaskReviewSummary('checkpoint')
    await expect(harness.commitTask('checkpoint', { expectedRevision: checkpointSummary.revision,
      expectedSeq: checkpointBefore.asOfSeq, message: 'SDK save receipt' })).rejects.toThrow('Delivery result is unconfirmed')
    const checkpoint = row('checkpoint', (await harness.listTasks()).tasks)
    const checkpointId = checkpoint.retryableDeliveryCheckpoint
    if (checkpointId === undefined || checkpoint.executionWorkspace === undefined) throw new Error('SDK has no retryable checkpoint')
    const checkpointHead = git(['rev-parse', checkpoint.executionWorkspace.branch])
    const saved = await harness.retryTaskDeliveryCheckpoint('checkpoint', checkpointId)
    expect(saved.retryableDeliveryCheckpoint).toBeUndefined()
    expect(saved.attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(false)
    expect(saved.commitReceipt?.operationId).toBe(checkpointId)
    expect(saved.asOfSeq).toBe(checkpoint.asOfSeq)
    expect(git(['rev-parse', checkpoint.executionWorkspace.branch])).toBe(checkpointHead)
    const uncertain = row('unconfirmed', (await harness.listTasks()).tasks)
    const before = await harness.getTaskReviewSummary('unconfirmed')
    await expect(harness.commitTask('unconfirmed', {
      expectedRevision: before.revision, expectedSeq: uncertain.asOfSeq, message: 'SDK lost result',
    })).rejects.toThrow('Delivery result is unconfirmed')
    // A following response is a wire-order fence for the previously emitted notifications.
    const baseline = await harness.listTasks()
    for (let notification = subscription.tryNext(); notification !== undefined; notification = subscription.tryNext()) {
      if (notification.method === 'session.event') events.push(notification.params['event'] as SessionEvent)
    }
    subscription.close()
    const intents = events.filter(event => event.type === 'task/delivery-started')
    const completions = events.filter(event => event.type === 'task/review-committed'
      || event.type === 'task/review-applied' || event.type === 'task/review-discarded')
    expect(intents.map(event => event.data.intent.kind)).toEqual(['commit', 'apply', 'discard', 'commit', 'commit'])
    expect(completions).toHaveLength(4)
    for (const event of completions) expect(intents.some(intent =>
      intent.data.intent.operationId === event.data.receipt.operationId
      && intent.data.intent.kind === event.data.receipt.kind
      && intent.data.intent.reviewRevision === event.data.receipt.reviewRevision)).toBe(true)
    const pending = row('unconfirmed', baseline.tasks)
    const operationId = pending.attention.find(item => item.kind === 'delivery-unconfirmed')?.sourceId
    expect(operationId).toBe(intents[4]?.data.intent.operationId)
    expect(pending.retryableDeliveryCheckpoint).toBeUndefined()
    expect(pending.commitReceipt).toBeUndefined()
    if (operationId === undefined) throw new Error('Unconfirmed Task has no delivery operation')
    await expect(harness.retryTaskDeliveryCheckpoint('unconfirmed', operationId)).rejects.toThrow('No matching live delivery receipt')
    const branch = pending.executionWorkspace?.branch
    if (branch === undefined) throw new Error('Unconfirmed Task has no branch')
    const lostCommit = git(['rev-parse', branch])
    expect(git(['show', '-s', '--format=%s', lostCommit])).toBe('SDK lost result')
    expect(await readFile(join(cwd, 'source', 'tracked.txt'), 'utf8')).toBe('delivered\n')
    expect(git(['rev-parse', 'HEAD'])).toBe(summary.sourceHead)
    expect(git(['rev-parse', initial.executionWorkspace!.branch])).toBe(receipt.commit)
    expect(existsSync(initial.executionWorkspace!.path)).toBe(false)
    await harness.close()
    harness = create()
    const restored = await harness.listTasks()
    const cold = row('unconfirmed', restored.tasks)
    const coldSaved = row('checkpoint', restored.tasks)
    expect(coldSaved.commitReceipt?.operationId).toBe(checkpointId)
    expect(coldSaved.retryableDeliveryCheckpoint).toBeUndefined()
    expect(coldSaved.attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(false)
    expect(coldSaved.asOfSeq).toBe(saved.asOfSeq)
    expect(git(['rev-parse', checkpoint.executionWorkspace.branch])).toBe(checkpointHead)
    expect(cold.attention.find(item => item.kind === 'delivery-unconfirmed')?.sourceId).toBe(operationId)
    await expect(harness.retryTaskDeliveryCheckpoint('unconfirmed', operationId)).rejects.toThrow('No matching live delivery receipt')
    await expect(harness.commitTask('unconfirmed', { expectedRevision: before.revision,
      expectedSeq: cold.asOfSeq, message: 'Do not repeat' })).rejects.toThrow()
    expect(git(['rev-parse', branch])).toBe(lostCommit)
    const result = { operations: intents.map(event => event.data.intent.kind),
      correlatedReceipts: completions.map(event => event.data.receipt.kind),
      status: discarded.status, sourceHeadPreserved: true, sourceContentApplied: true,
      worktreeRemoved: true, branchRetained: true, unconfirmed: { status: cold.status,
        attention: cold.attention.map(item => item.kind), operationIdRetained: true,
        receiptAbsent: cold.commitReceipt === undefined, retryRejected: true, gitCommitPreserved: true },
      checkpointRetry: { advertised: true, operationIdMatched: true, attentionCleared: true,
        noEventAppended: true, gitCommitPreserved: true, coldReceiptRetained: true },
      missingReceiptRetryRejected: { live: true, cold: true } }
    const output = `${JSON.stringify(result, null, 2)}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await mkdir(dirname(expected), { recursive: true })
      await writeFile(expected, output)
    }
    expect(output).toBe(await readFile(expected, 'utf8'))
  } finally {
    await harness.close()
    await rm(cwd, { recursive: true, force: true })
  }
}, 75_000)
