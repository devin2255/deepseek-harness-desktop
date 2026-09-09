/** Keyless assembled acceptance for durable Tasks and descendant attention. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TaskCriterionId, TaskRiskId } from '@deepseek-ai/dsh-task'
import TaskSessionProvider from '@deepseek-ai/dsh-task-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import {
  compareOrRefreshGolden, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('../../../examples/snapshots/task-attention/cordis.yml', import.meta.url))
const GOLDEN = join(process.cwd(), 'apps/web/tests/snapshots/task-attention/lifecycle.expected.txt')

describe('web snapshot: durable Task attention lifecycle', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const readyId = SessionId('task-ready')
  const failedId = SessionId('task-failed')
  const childId = SessionId('task-ready-child')
  const approvalId = ApprovalRequestId('review-desktop-output')

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    const ready = scaffold.ctx.sessions.create(readyId, { meta: { cwd: scaffold.workspaceCwd } })
    ready.append('session/title', { title: 'Installer delivery', messageSeqs: [], source: { kind: 'user' } })
    const definitionSeq = ready.events.length
    await scaffold.ctx.tasks.define(ready.id, {
      goal: 'Ship the desktop installer',
      criteria: [{ id: TaskCriterionId('installer'), text: 'Installer preserves Task identity' }],
      expectedSeq: definitionSeq,
    })
    await scaffold.ctx.tasks.updateCriterion(ready.id, {
      criterion: {
        id: TaskCriterionId('installer'),
        text: 'Installer preserves Task identity',
        status: 'satisfied',
        evidence: [{ sessionId: ready.id, seq: definitionSeq }],
      },
      expectedSeq: ready.events.length,
    })
    await scaffold.ctx.tasks.review(ready.id, { decision: 'ready', expectedSeq: ready.events.length })

    const child = scaffold.ctx.sessions.create(childId, {
      meta: { cwd: scaffold.workspaceCwd, origin: 'subagent', parentSession: ready.id },
    })
    child.append('session/title', { title: 'Installer reviewer', messageSeqs: [], source: { kind: 'user' } })
    child.append('approval/asked', {
      id: approvalId,
      toolName: 'review_output',
      reason: 'Review the descendant installer output',
    })

    const failed = scaffold.ctx.sessions.create(failedId, { meta: { cwd: scaffold.workspaceCwd } })
    failed.append('session/title', { title: 'Upgrade recovery', messageSeqs: [], source: { kind: 'user' } })
    await scaffold.ctx.tasks.define(failed.id, {
      goal: 'Verify upgrade recovery',
      criteria: [{ id: TaskCriterionId('recovery'), text: 'Upgrade recovery passes' }],
      expectedSeq: failed.events.length,
    })
    await scaffold.ctx.tasks.recordRisk(failed.id, {
      risk: { id: TaskRiskId('upgrade'), severity: 'high', summary: 'Upgrade left a stale runtime' },
      expectedSeq: failed.events.length,
    })
    failed.append('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: 'Upgrade recovery validation failed', code: 'VALIDATION_FAILED' } },
    })

    browser = await chromium.launch().catch(async (error: unknown) => {
      if (process.platform !== 'win32'
        || !(error instanceof Error)
        || !error.message.includes("Executable doesn't exist")) throw error
      return chromium.launch({ channel: 'chrome' })
    })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.getByRole('button', { name: 'Tasks' }).click()
    await page.getByRole('main', { name: 'Tasks' }).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('projects attention, failure, readiness, and retained disconnected rows', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-task-attention'))
    const overview = page.getByRole('main', { name: 'Tasks' })
    await expect.poll(() => overview.innerText()).toContain('Review the descendant installer output')
    await expect.poll(() => overview.innerText()).toContain('Upgrade recovery validation failed')
    const initial = await overview.innerText()

    const child = scaffold.ctx.sessions.get(childId)
    if (child === undefined) throw new Error('descendant Session disappeared')
    child.append('approval/decided', { id: approvalId, outcome: 'allowed-once' })
    await expect.poll(() => overview.innerText()).toContain('Ready')
    await expect.poll(() => overview.innerText()).not.toContain('Review the descendant installer output')
    const ready = await overview.innerText()

    const tasks = scaffold.ctx.tasks as TaskSessionProvider
    tasks.invalidateLiveGeneration(tasks.snapshot().generation)
    await expect.poll(() => overview.innerText()).toContain('Last known before disconnect')
    const disconnected = await overview.innerText()

    await compareOrRefreshGolden(GOLDEN, [
      '--- initial ---', initial,
      '--- ready ---', ready,
      '--- disconnected ---', disconnected,
    ].join('\n'), scaffold.mode)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
