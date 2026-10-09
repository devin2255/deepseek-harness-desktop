/** Real Git evidence after a lost delivery response, through the assembled Review UI. */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { TaskDeliveryInspection } from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type {} from '@deepseek-ai/dsh-task'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  acknowledgeReloadConnectionLoss, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('../../../examples/jsonrpc-agent/tests/fixtures/task-delivery/web.overlay.yml', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./snapshots/task-delivery-inspection/ui.expected.md', import.meta.url))
const ids = {
  commit: SessionId('browser-inspect-commit'), absent: SessionId('browser-inspect-absent'),
  discard: SessionId('browser-inspect-discard'), apply: SessionId('browser-inspect-apply'),
}
const goal = (id: SessionId): string => `Inspect ${id}`

describe.skipIf(MODE === 'record')('web e2e: inspect missing delivery receipts without repeating Git', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let source: string
  let baseCommit: string
  let lastInspection: TaskDeliveryInspection
  const sessions = new Map<SessionId, Session>()
  const assignments = new Map<SessionId, TaskWorktreeAssignment>()
  const resultCommits = new Map<string, string>()
  const git = (cwd: string, args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  const session = (id: SessionId): Session => {
    const value = sessions.get(id)
    if (value === undefined) throw new Error(`Missing inspection fixture session: ${id}`)
    return value
  }
  const assignment = (id: SessionId): TaskWorktreeAssignment => {
    const value = assignments.get(id)
    if (value === undefined) throw new Error(`Missing inspection fixture worktree: ${id}`)
    return value
  }
  const task = (id: SessionId) => {
    const value = scaffold.ctx.tasks.snapshot().tasks.find(row => row.taskId === id)
    if (value === undefined) throw new Error(`Missing inspection fixture task: ${id}`)
    return value
  }
  const review = () => page.getByRole('main', { name: 'Change Review' })
  const inspectButton = () => review().getByRole('button', { name: 'Inspect current Git result' })
  const evidence = () => review().getByRole('region', { name: 'Delivery inspection evidence' })
  const openReview = async (id: SessionId): Promise<void> => {
    const overview = page.getByRole('main', { name: 'Tasks' })
    await overview.waitFor()
    const row = overview.getByRole('listitem').filter({ has: page.getByRole('button', { name: goal(id), exact: true }) })
    await row.getByRole('button', { name: /Review changes|Delivery result unconfirmed:/ }).first().click()
    await review().waitFor()
  }
  const inspect = async (status: TaskDeliveryInspection['status']): Promise<void> => {
    await expect.poll(() => inspectButton().isEnabled()).toBe(true)
    await inspectButton().click()
    await evidence().waitFor()
    expect(lastInspection.status).toBe(status)
    for (const name of ['Request Changes', 'Create Commit', 'Apply to Project', 'Discard Worktree']) {
      expect(await review().getByRole('button', { name }).isEnabled()).toBe(false)
    }
    expect(await review().getByRole('button', { name: 'Confirm', exact: true }).count()).toBe(0)
  }
  const snapshot = async (): Promise<string> => {
    let value = await captureStableAria(page, 'main[aria-label="Change Review"]', scaffold.workspaceCwd)
    const replacements: [string, string][] = [
      [baseCommit, '{{baseCommit}}'], [baseCommit.slice(0, 10), '{{baseCommitShort}}'],
      [lastInspection.intent.operationId, '{{operationId}}'],
      [lastInspection.intent.reviewRevision, '{{authorizedRevision}}'],
      [`${new Date(lastInspection.observedAt).toISOString().slice(0, 10)}T{{clock}}Z`, '{{observedAt}}'],
    ]
    for (const [name, commit] of resultCommits) replacements.push([commit, `{{${name}Commit}}`], [commit.slice(0, 10), `{{${name}CommitShort}}`])
    if (lastInspection.intent.kind === 'commit') replacements.push([lastInspection.intent.tree, '{{authorizedTree}}'])
    if (lastInspection.status === 'completed' && lastInspection.effect.kind === 'commit') {
      replacements.push([lastInspection.effect.committedRevision, '{{committedRevision}}'])
    }
    if (lastInspection.status === 'completed' && lastInspection.effect.kind === 'apply') {
      replacements.push([lastInspection.effect.sourceTree, '{{sourceTree}}'])
    }
    for (const [original, replacement] of replacements) value = value.split(original).join(replacement)
    return value
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    source = join(scaffold.workspaceCwd, 'source')
    await mkdir(source)
    git(source, ['init', '--initial-branch=main'])
    git(source, ['config', 'core.autocrlf', 'false'])
    git(source, ['config', 'user.name', 'Browser Inspection Fixture'])
    git(source, ['config', 'user.email', 'fixture@localhost'])
    await writeFile(join(source, 'tracked.txt'), 'base\n')
    git(source, ['add', '.'])
    git(source, ['commit', '-m', 'base'])
    baseCommit = git(source, ['rev-parse', 'HEAD'])
    const workspace = await scaffold.ctx.workspaceRegistry.create(source)
    for (const id of Object.values(ids)) {
      const assigned = await scaffold.ctx.taskWorktrees.create({ taskId: id, workspaceId: workspace.id, workspacePath: source })
      assignments.set(id, assigned)
      const owner = scaffold.ctx.sessions.create(id, { meta: { cwd: assigned.path } })
      sessions.set(id, owner)
      owner.append('task/worktree-assigned', { assignment: assigned })
      const defined = await scaffold.ctx.tasks.define(id, { goal: goal(id), criteria: [{ text: 'Inspect exact Git facts' }], expectedSeq: owner.seq })
      const criterion = defined.definition?.criteria[0]
      if (criterion === undefined) throw new Error('Inspection fixture has no criterion')
      await scaffold.ctx.tasks.updateCriterion(id, { criterion: { ...criterion, status: 'waived' }, expectedSeq: owner.seq })
      await scaffold.ctx.tasks.review(id, { decision: 'ready', expectedSeq: owner.seq })
      await writeFile(join(assigned.path, 'tracked.txt'), 'delivered\n')
      expect(await scaffold.ctx.sessions.flush(owner)).toBe(true)
    }
    const discarded = assignment(ids.discard)
    git(discarded.path, ['add', '.'])
    git(discarded.path, ['commit', '-m', 'Retained branch before discard'])
    resultCommits.set('discard', git(discarded.path, ['rev-parse', 'HEAD']))
    await writeFile(join(discarded.path, 'uncommitted.txt'), 'unrecoverable fixture content\n')

    // Lose only the return across authorization/result checkpoints; Git and persistence remain real.
    const commit = scaffold.ctx.taskReview.commit.bind(scaffold.ctx.taskReview)
    scaffold.ctx.taskReview.commit = async (request, signal) => {
      if (request.assignment.taskId === ids.absent) {
        const authorization = request.authorization
        if (authorization === undefined) throw new Error('Inspection fixture requires Host authorization')
        return commit({ ...request, authorization: { ...authorization, authorize: async (preflight) => {
          await authorization.authorize(preflight)
          throw new Error('Injected lost authorization response before Git mutation')
        } } }, signal)
      }
      const receipt = await commit(request, signal)
      if (request.assignment.taskId === ids.commit) throw new Error('Injected lost Commit result')
      return receipt
    }
    const discard = scaffold.ctx.taskReview.discard.bind(scaffold.ctx.taskReview)
    scaffold.ctx.taskReview.discard = async (request, signal) => {
      await discard(request, signal)
      throw new Error('Injected lost Discard result')
    }
    const apply = scaffold.ctx.taskReview.apply.bind(scaffold.ctx.taskReview)
    scaffold.ctx.taskReview.apply = async (request, signal) => {
      await apply(request, signal)
      throw new Error('Injected lost Apply result')
    }
    const inspectDelivery = scaffold.ctx.taskReview.inspectDelivery.bind(scaffold.ctx.taskReview)
    scaffold.ctx.taskReview.inspectDelivery = async (request, signal) => {
      lastInspection = await inspectDelivery(request, signal)
      return lastInspection
    }
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  }, 120_000)

  afterAll(async () => {
    const outcomes = await Promise.allSettled([browser?.close(), scaffold?.close()])
    const errors = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
    if (errors.length > 0) throw new AggregateError(errors, 'Browser inspection cleanup failed')
  })

  it('shows complete, ambiguous, absent, removed, and applied facts without adoption or repeated Git', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-task-delivery-inspection'))
    const tripwire = watchConsole(page)
    const captures: string[] = []
    await openReview(ids.commit)
    await review().getByLabel('Commit message').fill('Lost browser commit')
    await review().getByRole('button', { name: 'Create Commit', exact: true }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await inspectButton().waitFor()
    await expect.poll(() => inspectButton().isEnabled()).toBe(true)
    resultCommits.set('task', git(source, ['rev-parse', assignment(ids.commit).branch]))
    const committedSeq = session(ids.commit).seq
    const indexBefore = await readFile(git(assignment(ids.commit).path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))
    await inspect('completed')
    await review().getByText('This review may be out of date.', { exact: true }).waitFor()
    captures.push(`# Completed Commit evidence\n\n${await snapshot()}`)
    await page.screenshot({ path: fileURLToPath(new URL('../../../.artifacts/task-delivery-inspection-ui.png', import.meta.url)) })
    expect(task(ids.commit).commitReceipt).toBeUndefined()
    expect(task(ids.commit).retryableDeliveryCheckpoint).toBeUndefined()
    expect(task(ids.commit).attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(true)
    await review().getByRole('button', { name: 'Refresh', exact: true }).click()
    await expect.poll(() => evidence().count()).toBe(0)
    await writeFile(join(assignment(ids.commit).path, 'tracked.txt'), 'external change\n')
    await inspect('ambiguous')
    captures.push(`# Externally changed Task\n\n${await snapshot()}`)
    expect(session(ids.commit).seq).toBe(committedSeq)
    expect(await readFile(git(assignment(ids.commit).path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))).toEqual(indexBefore)
    expect(git(source, ['rev-parse', assignment(ids.commit).branch])).toBe(resultCommits.get('task'))
    await review().getByRole('button', { name: 'Back to Tasks' }).click()

    await openReview(ids.absent)
    await review().getByLabel('Commit message').fill('Authorized but absent')
    await review().getByRole('button', { name: 'Create Commit', exact: true }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await inspectButton().waitFor()
    await expect.poll(() => inspectButton().isEnabled()).toBe(true)
    const absentSeq = session(ids.absent).seq
    await inspect('not-completed')
    captures.push(`# Authorized result absent now\n\n${await snapshot()}`)
    expect(git(source, ['rev-parse', assignment(ids.absent).branch])).toBe(baseCommit)
    expect(session(ids.absent).seq).toBe(absentSeq)
    await review().getByRole('button', { name: 'Back to Tasks' }).click()

    await openReview(ids.discard)
    await review().getByRole('button', { name: 'Discard Worktree' }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await inspectButton().waitFor()
    await expect.poll(() => inspectButton().isEnabled()).toBe(true)
    expect(existsSync(assignment(ids.discard).path)).toBe(false)
    const discardedSeq = session(ids.discard).seq
    const warningsBeforeReload = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningsBeforeReload)
    await openReview(ids.discard)
    await inspect('completed')
    expect(lastInspection.status === 'completed' && lastInspection.effect.kind).toBe('discard')
    captures.push(`# Discard evidence after renderer reload\n\n${await snapshot()}`)
    expect(task(ids.discard).discardReceipt).toBeUndefined()
    expect(session(ids.discard).seq).toBe(discardedSeq)
    expect(git(source, ['rev-parse', assignment(ids.discard).branch])).toBe(resultCommits.get('discard'))
    await review().getByRole('button', { name: 'Back to Tasks' }).click()

    await openReview(ids.apply)
    await review().getByLabel('Commit message').fill('Apply inspection commit')
    await review().getByRole('button', { name: 'Create Commit', exact: true }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await review().getByText('Task changes were committed.', { exact: true }).waitFor()
    resultCommits.set('apply', git(source, ['rev-parse', assignment(ids.apply).branch]))
    await expect.poll(() => review().getByRole('button', { name: 'Apply to Project' }).isEnabled()).toBe(true)
    await review().getByRole('button', { name: 'Apply to Project' }).click()
    await review().getByRole('button', { name: 'Confirm', exact: true }).click()
    await inspectButton().waitFor()
    await expect.poll(() => inspectButton().isEnabled()).toBe(true)
    const appliedSeq = session(ids.apply).seq
    const sourceIndex = await readFile(join(source, '.git', 'index'))
    await inspect('completed')
    expect(lastInspection.status === 'completed' && lastInspection.effect.kind).toBe('apply')
    captures.push(`# Apply evidence without a receipt\n\n${await snapshot()}`)
    expect(task(ids.apply).applyReceipt).toBeUndefined()
    expect(session(ids.apply).seq).toBe(appliedSeq)
    expect(await readFile(join(source, '.git', 'index'))).toEqual(sourceIndex)
    expect(git(source, ['rev-parse', 'HEAD'])).toBe(baseCommit)
    expect(await readFile(join(source, 'tracked.txt'), 'utf8')).toBe('delivered\n')
    for (const id of Object.values(ids)) {
      expect(session(id).events.filter(event => event.type === 'task/delivery-started')).toHaveLength(id === ids.apply ? 2 : 1)
      expect(task(id).attention.some(item => item.kind === 'delivery-unconfirmed')).toBe(true)
    }
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await compareOrRefreshGolden(EXPECTED, captures.join('\n\n'), MODE)
  }, 120_000)
})
