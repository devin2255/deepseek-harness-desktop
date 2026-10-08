/** Real browser recovery of Git delivery receipts, including a removed worktree. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-task'
import type {} from '@deepseek-ai/dsh-task-worktree'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL(
  '../../../examples/jsonrpc-agent/tests/fixtures/task-delivery/web.overlay.yml', import.meta.url,
))
const EXPECTED = fileURLToPath(new URL('./snapshots/task-delivery-checkpoint/ui.expected.md', import.meta.url))
const TASK_ID = SessionId('browser-delivery-checkpoint')

describe.skipIf(MODE === 'record')('web e2e: save an existing delivery receipt without repeating Git', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let session: Session
  let source: string
  let worktree: string
  let branch: string
  let baseCommit: string
  let taskCommit: string
  const failedCheckpoints = new Set<string>()

  const git = (args: string[]): string => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim()
  const task = () => {
    const value = scaffold.ctx.tasks.snapshot().tasks.find(row => row.taskId === TASK_ID)
    if (value === undefined) throw new Error('Browser delivery Task is missing')
    return value
  }
  const review = () => page.getByRole('main', { name: 'Change Review' })
  const saveButton = () => review().getByRole('button', { name: 'Retry saving delivery receipt' })
  const openReview = async (): Promise<void> => {
    await page.getByRole('main', { name: 'Tasks' }).waitFor()
    await page.getByRole('button', { name: /Review changes|Delivery result unconfirmed:/ }).click()
    await review().waitFor()
  }
  const snapshot = async (): Promise<string> => (await captureStableAria(
    page, 'main[aria-label="Change Review"]', scaffold.workspaceCwd,
  )).split(baseCommit).join('{{baseCommit}}')
    .split(baseCommit.slice(0, 10)).join('{{baseCommitShort}}')
    .split(taskCommit).join('{{taskCommit}}')
    .split(taskCommit.slice(0, 10)).join('{{taskCommitShort}}')

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    source = join(scaffold.workspaceCwd, 'source')
    await mkdir(source)
    git(['init', '--initial-branch=main'])
    git(['config', 'core.autocrlf', 'false'])
    git(['config', 'user.name', 'Browser Delivery Fixture'])
    git(['config', 'user.email', 'fixture@localhost'])
    await writeFile(join(source, 'tracked.txt'), 'base\n')
    git(['add', '.'])
    git(['commit', '-m', 'base'])
    baseCommit = git(['rev-parse', 'HEAD'])
    const workspace = await scaffold.ctx.workspaceRegistry.create(source)
    const assignment = await scaffold.ctx.taskWorktrees.create({
      taskId: TASK_ID, workspaceId: workspace.id, workspacePath: source,
    })
    worktree = assignment.path
    branch = assignment.branch
    session = scaffold.ctx.sessions.create(TASK_ID, { meta: { cwd: worktree } })
    session.append('task/worktree-assigned', { assignment })
    const defined = await scaffold.ctx.tasks.define(TASK_ID, {
      goal: 'Recover browser delivery receipts', criteria: [{ text: 'Reviewed tracked file' }], expectedSeq: session.seq,
    })
    const criterion = defined.definition?.criteria[0]
    if (criterion === undefined) throw new Error('Browser delivery Task has no acceptance criterion')
    await scaffold.ctx.tasks.updateCriterion(TASK_ID, {
      criterion: { ...criterion, status: 'waived' }, expectedSeq: session.seq,
    })
    await scaffold.ctx.tasks.review(TASK_ID, { decision: 'ready', expectedSeq: session.seq })
    await writeFile(join(worktree, 'tracked.txt'), 'delivered\n')
    expect(await scaffold.ctx.sessions.flush(session)).toBe(true)
    // Fail only the first save after each real Git result, not authorization or Git itself.
    const flush = scaffold.ctx.sessions.flush.bind(scaffold.ctx.sessions)
    scaffold.ctx.sessions.flush = async (owner) => {
      const event = owner.events.at(-1)
      if (owner === session && (event?.type === 'task/review-committed' || event?.type === 'task/review-discarded')
        && !failedCheckpoints.has(event.type)) {
        failedCheckpoints.add(event.type)
        throw new Error('Injected browser receipt checkpoint failure')
      }
      return flush(owner)
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    const outcomes = await Promise.allSettled([browser?.close(), scaffold?.close()])
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Browser delivery cleanup failed')
  })

  it('saves Commit and Discard receipts through the real Host wire and survives renderer reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-task-delivery-checkpoint'))
    const tripwire = watchConsole(page)
    const captures: string[] = []
    await openReview()
    await review().getByLabel('tracked.txt', { exact: true }).waitFor()
    await review().getByLabel('Commit message').fill('Browser receipt recovery')
    await review().getByRole('button', { name: 'Create Commit', exact: true }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await saveButton().waitFor()
    await expect.poll(() => saveButton().isEnabled()).toBe(true)
    const pendingCommit = task()
    expect(pendingCommit.retryableDeliveryCheckpoint).toBeDefined()
    expect(pendingCommit.attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(true)
    taskCommit = git(['rev-parse', branch])
    expect(git(['show', '-s', '--format=%s', taskCommit])).toBe('Browser receipt recovery')
    expect(git(['rev-parse', 'HEAD'])).toBe(baseCommit)
    expect(await readFile(join(source, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await review().getByRole('button', { name: 'Apply to Project' }).isEnabled()).toBe(false)
    captures.push(`# Unconfirmed commit\n\n${await snapshot()}`)
    const commitSeq = session.seq
    await saveButton().click()
    await review().getByText('Task changes were committed.', { exact: true }).waitFor()
    expect(task().commitReceipt?.operationId).toBe(pendingCommit.retryableDeliveryCheckpoint)
    expect(session.seq).toBe(commitSeq)
    expect(git(['rev-parse', branch])).toBe(taskCommit)
    expect(await saveButton().count()).toBe(0)

    await review().getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => review().getByRole('button', { name: 'Discard Worktree' }).isEnabled()).toBe(true)
    await review().getByRole('button', { name: 'Discard Worktree' }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await saveButton().waitFor()
    await expect.poll(() => saveButton().isEnabled()).toBe(true)
    const pendingDiscard = task()
    expect(pendingDiscard.retryableDeliveryCheckpoint).toBeDefined()
    expect(existsSync(worktree)).toBe(false)
    expect(git(['rev-parse', branch])).toBe(taskCommit)
    const discardSeq = session.seq

    // A new renderer must recover the action even when its initial review read fails on the removed directory.
    const warningsBeforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
    await openReview()
    await saveButton().waitFor()
    await expect.poll(() => saveButton().isEnabled()).toBe(true)
    captures.push(`# Removed worktree with an unsaved receipt\n\n${await snapshot()}`)
    await saveButton().click()
    await review().getByText('The task worktree was removed.', { exact: true }).waitFor()
    expect(task().discardReceipt?.operationId).toBe(pendingDiscard.retryableDeliveryCheckpoint)
    expect(task().retryableDeliveryCheckpoint).toBeUndefined()
    expect(task().attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(false)
    expect(session.seq).toBe(discardSeq)
    expect(git(['rev-parse', branch])).toBe(taskCommit)
    expect(git(['rev-parse', 'HEAD'])).toBe(baseCommit)
    expect(await readFile(join(source, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(worktree)).toBe(false)
    expect(session.events.filter(event => event.type === 'task/delivery-started')).toHaveLength(2)
    expect(session.events.filter(event => event.type === 'task/review-committed')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'task/review-discarded')).toHaveLength(1)
    const persisted = await scaffold.ctx.sessionPersistence.inspect(TASK_ID)
    expect(persisted.events.at(-1)?.seq).toBe(session.events.at(-1)?.seq)
    expect(persisted.events.filter(event => event.type === 'task/review-discarded')).toHaveLength(1)
    captures.push(`# Confirmed discard\n\n${await snapshot()}`)
    expect([...failedCheckpoints]).toEqual(['task/review-committed', 'task/review-discarded'])
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await compareOrRefreshGolden(EXPECTED, captures.join('\n\n'), MODE)
  }, 90_000)
})
