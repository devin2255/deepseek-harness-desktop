import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, type ElectronApplication, type Locator, type Page, type Request } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

const DESKTOP_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const SENSITIVE_ENVIRONMENT_KEY = /KEY|SECRET|TOKEN|PASSWORD/iu
const DESCENDANT_PARENT_PROMPT = 'desktop descendant routing parent'
const DESCENDANT_CHILD_PROMPT = 'desktop descendant routing child'
const DESCENDANT_QUESTION = 'Should the desktop open this child Agent?'
const DESCENDANT_QUESTION_NAME = /Should the desktop open this child Agent\?/u

interface TaskIdentitySnapshot {
  readonly tasks: readonly {
    readonly taskId: string
    readonly status: string
    readonly asOfSeq: number
    readonly definition?: {
      readonly goal: string
      readonly criteria: readonly {
        readonly id: string
        readonly text: string
        readonly status: string
        readonly evidence: readonly { readonly sessionId: string; readonly seq: number }[]
      }[]
    }
    readonly workspaceId?: string
    readonly executionWorkspace?: {
      readonly kind: 'git-worktree'
      readonly taskId: string
      readonly workspaceId: string
      readonly sourcePath: string
      readonly path: string
      readonly branch: string
      readonly baseCommit: string
      readonly sourceHead: string
      readonly sourceDirty: boolean
      readonly sourceStatusDigest: string
      readonly createdAt: number
    }
    readonly attention: readonly {
      readonly id: string
      readonly ownerSessionId: string
      readonly kind: string
      readonly summary: string
      readonly sourceId: string
    }[]
    readonly commitReceipt?: {
      readonly committedRevision: string
      readonly commit: string
    }
    readonly applyReceipt?: {
      readonly commit: string
      readonly sourceHeadBefore: string
      readonly sourceHeadAfter: string
    }
    readonly discardReceipt?: {
      readonly branch: string
      readonly branchPreserved: boolean
      readonly worktreeRemoved: boolean
      readonly recoverableCommit?: string
    }
  }[]
}

interface TaskReviewSummarySnapshot {
  readonly revision: string
  readonly sourceHead: string
  readonly dirty: boolean
  readonly files: readonly { readonly path: string; readonly binary: boolean }[]
}

let application: ElectronApplication | undefined
let provider: Server | undefined
let releaseProvider: (() => void) | undefined
let temporaryRoot: string | undefined

afterEach(async () => {
  const failures: unknown[] = []
  if (application !== undefined) {
    await boundedClose(application).catch((error: unknown) => failures.push(error))
    application = undefined
  }
  releaseProvider?.()
  releaseProvider = undefined
  if (provider !== undefined) {
    await new Promise<void>((resolve, reject) => { provider?.close((error) => { if (error) reject(error); else resolve() }) })
      .catch((error: unknown) => failures.push(error))
    provider = undefined
  }
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    temporaryRoot = undefined
  }
  if (failures.length > 0) throw new AggregateError(failures, 'desktop e2e cleanup failed')
})

describe('desktop Electron acceptance', () => {
  it('boots the secured desktop profile and reaches process quiescence on close', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-desktop-e2e-'))
    const environment = await isolatedEnvironment(temporaryRoot)
    const pendingProviderResponses: ServerResponse[] = []
    let observedParentPrompt = false
    let observedChildPrompt = false
    let descendantQuestionDispatchCount = 0
    let providerReleased = false
    const finishProviderResponse = (response: ServerResponse): void => {
      sendProviderEvents(response, textCompletionEvents('desktop task complete'))
    }
    provider = createServer((request, response) => {
      void readProviderRequest(request).then((body) => {
        const conversation = providerMessageText(body)
        if (conversation.includes(DESCENDANT_CHILD_PROMPT)) {
          observedChildPrompt = true
          if (!providerHasTool(body, 'ask_user_question')) {
            sendProviderEvents(response, textCompletionEvents('Desktop child question'))
            return
          }
          if (providerHasToolResult(body)) {
            sendProviderEvents(response, textCompletionEvents('desktop child answered'))
            return
          }
          descendantQuestionDispatchCount += 1
          sendProviderEvents(response, toolCallEvents('desktop-child-question', 'ask_user_question', {
            questions: [{
              id: 'desktop-child-question',
              question: DESCENDANT_QUESTION,
              header: 'Confirm child',
              options: [
                { label: 'Open child', description: 'Navigate to the child Agent that owns this question.' },
                { label: 'Stay here', description: 'Keep the current task selected.' },
              ],
            }],
          }))
          return
        }
        if (conversation.includes(DESCENDANT_PARENT_PROMPT)) {
          observedParentPrompt = true
          if (!providerHasTool(body, 'subagent')) {
            sendProviderEvents(response, textCompletionEvents('Desktop descendant routing'))
            return
          }
          if (providerHasToolResult(body)) {
            sendProviderEvents(response, textCompletionEvents('desktop parent delegated'))
            return
          }
          sendProviderEvents(response, toolCallEvents('desktop-spawn-child', 'subagent', {
            description: 'Desktop child question',
            prompt: `${DESCENDANT_CHILD_PROMPT}: use ask_user_question once, then wait for the answer.`,
            run_in_background: true,
          }))
          return
        }
        if (providerReleased) finishProviderResponse(response)
        else {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          pendingProviderResponses.push(response)
        }
      }, (error: unknown) => {
        response.writeHead(400, { 'content-type': 'text/plain' })
        response.end(String(error))
      })
    })
    await new Promise<void>(resolve => provider?.listen(0, '127.0.0.1', resolve))
    const providerAddress = provider.address()
    if (providerAddress === null || typeof providerAddress === 'string') throw new Error('desktop mock model did not bind')
    environment.DEEPSEEK_API_KEY = 'desktop-acceptance-key'
    environment.DEEPSEEK_BASE_URL = `http://127.0.0.1:${String(providerAddress.port)}`
    releaseProvider = () => {
      providerReleased = true
      for (const response of pendingProviderResponses.splice(0)) finishProviderResponse(response)
    }
    // Electron reads appData through native shell folders on Windows, not APPDATA.
    const entry = join(temporaryRoot, 'isolated-entry.mjs')
    await writeFile(entry, [
      "import { app, dialog, Notification, Tray, utilityProcess } from 'electron'",
      "const nativeAcceptance = { activeTrays: new Set(), dialogCalls: [], dialogResponses: [], harnessProcesses: [], notificationListeners: new Map(), notifications: [], tray: undefined, trayListeners: {}, trayToolTip: '' }",
      'globalThis.__dshDesktopNativeAcceptance = nativeAcceptance',
      'const harnessFork = utilityProcess.fork.bind(utilityProcess)',
      'utilityProcess.fork = (...args) => { const child = harnessFork(...args); nativeAcceptance.harnessProcesses.push(child); return child }',
      'const trayOn = Tray.prototype.on',
      'Tray.prototype.on = function (event, listener) { nativeAcceptance.activeTrays.add(this); nativeAcceptance.tray = this; nativeAcceptance.trayListeners[event] = listener; return trayOn.call(this, event, listener) }',
      'const trayDestroy = Tray.prototype.destroy',
      'Tray.prototype.destroy = function () { nativeAcceptance.activeTrays.delete(this); return trayDestroy.call(this) }',
      'const setToolTip = Tray.prototype.setToolTip',
      'Tray.prototype.setToolTip = function (value) { nativeAcceptance.tray = this; nativeAcceptance.trayToolTip = value; return setToolTip.call(this, value) }',
      'const notificationOn = Notification.prototype.on',
      'Notification.prototype.on = function (event, listener) { const listeners = nativeAcceptance.notificationListeners.get(this) ?? {}; listeners[event] = listener; nativeAcceptance.notificationListeners.set(this, listeners); return notificationOn.call(this, event, listener) }',
      'Notification.prototype.show = function () { nativeAcceptance.notifications.push({ notification: this, listeners: nativeAcceptance.notificationListeners.get(this) ?? {}, title: this.title, body: this.body }) }',
      "dialog.showMessageBox = async (...args) => { const options = args.at(-1); nativeAcceptance.dialogCalls.push(options); const response = nativeAcceptance.dialogResponses.shift(); if (response === undefined) throw new Error('desktop acceptance did not queue a quit decision'); return { response, checkboxChecked: false } }",
      `app.setPath('appData', ${JSON.stringify(environment.APPDATA)})`,
      `app.setPath('home', ${JSON.stringify(join(temporaryRoot, 'home'))})`,
      `await import(${JSON.stringify(pathToFileURL(join(DESKTOP_ROOT, 'lib', 'main.js')).href)})`,
      '',
    ].join('\n'))
    application = await electron.launch({
      args: [entry, `--user-data-dir=${join(temporaryRoot, 'electron-profile')}`],
      env: environment,
      timeout: 15_000,
    })

    const startup = await application.firstWindow({ timeout: 5_000 })
    expect(startup.url()).toMatch(/^file:/u)
    expect(await application.evaluate(({ app }) => app.getPath('appData'))).toBe(environment.APPDATA)
    expect(await application.evaluate(({ app }) => app.getPath('home'))).toBe(join(temporaryRoot, 'home'))
    let mainWindow: Page | undefined
    await expect.poll(() => {
      mainWindow = application?.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\//u.test(window.url()))
      return mainWindow !== undefined
    }, { timeout: 75_000 }).toBe(true).catch(async (error: unknown) => {
      const diagnostics = join(DESKTOP_ROOT, '..', '..', '.artifacts', 'desktop')
      await mkdir(diagnostics, { recursive: true })
      const log = await readFile(join(environment.APPDATA!, 'DeepSeek Harness', 'logs', 'desktop.log'), 'utf8')
      await writeFile(join(diagnostics, 'task-overview-startup.log'), log)
      throw error
    })
    if (mainWindow === undefined) throw new Error('The authorized desktop window did not open')
    let page: Page = mainWindow
    await page.waitForLoadState('load')
    await page.addInitScript({ content: HARNESS_SOCKET_PROBE })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => application?.windows().length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.title(), { timeout: 10_000 }).toBe('DeepSeek Harness')
    await expect.poll(async () => page.locator('#root').innerHTML(), { timeout: 10_000 })
      .not.toBe('')

    let overview = page.getByRole('main', { name: /^(Tasks|任务)$/u })
    await overview.waitFor({ state: 'visible', timeout: 15_000 })
    const continueButton = page.getByRole('button', { name: /^(Continue|继续)$/u })
    await continueButton.click()
    await continueButton.waitFor({ state: 'hidden' })
    const configureLater = page.getByRole('button', { name: /^(Configure later|稍后配置)$/u })
    if (await configureLater.isVisible()) {
      await configureLater.click()
      await configureLater.waitFor({ state: 'hidden' })
    }
    const newTask = overview.getByRole('button', { name: /^(New Task|新建任务)$/u })
    await expect.poll(() => newTask.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await overview.getByRole('heading').count()).toBe(4)
    expect(await overview.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const screenshots = join(DESKTOP_ROOT, '..', '..', '.artifacts', 'desktop')
    await mkdir(screenshots, { recursive: true })
    await page.screenshot({ path: join(screenshots, 'task-overview-electron.png') })
    await newTask.click()
    await overview.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /^(Tasks|任务)$/u }).click()
    await overview.waitFor({ state: 'visible' })

    const workspaceA = join(temporaryRoot, 'workspace-a')
    const workspaceB = join(temporaryRoot, 'workspace-b')
    await Promise.all([mkdir(workspaceA), mkdir(workspaceB)])
    const [firstWorkspace, secondWorkspace] = await Promise.all([
      pageRpc<{ workspace: { workspaceId: string } }>(page, 'workspace.create', { path: workspaceA }),
      pageRpc<{ workspace: { workspaceId: string } }>(page, 'workspace.create', { path: workspaceB }),
    ])
    const [firstSession, secondSession] = await Promise.all([
      pageRpc<{ sessionId: string }>(page, 'session.create', { workspaceId: firstWorkspace.workspace.workspaceId }),
      pageRpc<{ sessionId: string }>(page, 'session.create', { workspaceId: secondWorkspace.workspace.workspaceId }),
    ])
    await Promise.all([
      pageRpc(page, 'session.prompt', { sessionId: firstSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'run task alpha' }] }),
      pageRpc(page, 'session.prompt', { sessionId: secondSession.sessionId, mode: 'queue', content: [{ type: 'text', text: 'run task beta' }] }),
    ])
    await expect.poll(async () => {
      const projection = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
      return projection.tasks
        .filter(task => task.taskId === firstSession.sessionId || task.taskId === secondSession.sessionId)
        .map(task => ({ taskId: task.taskId, status: task.status }))
        .sort((left, right) => left.taskId.localeCompare(right.taskId))
    }, { timeout: 15_000 }).toEqual([
      { taskId: firstSession.sessionId, status: 'running' },
      { taskId: secondSession.sessionId, status: 'running' },
    ].sort((left, right) => left.taskId.localeCompare(right.taskId)))
    await expectBothWorkspacesRunning(overview)

    await expect.poll(async () => (await nativeAcceptanceSnapshot(application!)).trayToolTip, { timeout: 15_000 })
      .toMatch(/2 (?:tasks running|个任务运行中)/u)
    await page.close()
    await expect.poll(() => application?.windows().length, { timeout: 10_000 }).toBe(0)
    await emitTrayClick(application)
    let reopenedWindow: Page | undefined
    await expect.poll(() => {
      reopenedWindow = application?.windows().find(window => /^http:\/\/127\.0\.0\.1:\d+\//u.test(window.url()))
      return reopenedWindow !== undefined
    }, { timeout: 15_000 }).toBe(true).catch(async (error: unknown) => {
      const native = await nativeAcceptanceSnapshot(application!)
      const log = await readFile(join(environment.APPDATA!, 'DeepSeek Harness', 'logs', 'desktop.log'), 'utf8')
      await writeFile(join(screenshots, 'task-tray-reopen.log'), `${JSON.stringify(native, null, 2)}\n${log}`)
      throw error
    })
    if (reopenedWindow === undefined) throw new Error('Tray did not recreate the authorized desktop window')
    page = reopenedWindow
    await page.waitForLoadState('load')
    await page.addInitScript({ content: HARNESS_SOCKET_PROBE })
    await page.reload({ waitUntil: 'load' })
    overview = page.getByRole('main', { name: /^(Tasks|任务)$/u })
    if (!await overview.isVisible()) {
      await page.getByRole('button', { name: /^(Tasks|任务)$/u }).click()
    }
    await overview.waitFor({ state: 'visible', timeout: 15_000 })
    await expectBothWorkspacesRunning(overview).catch(async (error: unknown) => {
      const projection = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
      await page.screenshot({ path: join(screenshots, 'task-tray-reopened.png') })
      await writeFile(join(screenshots, 'task-tray-reopened.html'), await page.content())
      await writeFile(join(screenshots, 'task-tray-reopened.json'), JSON.stringify({
        native: await nativeAcceptanceSnapshot(application!),
        projection,
        overview: await overview.innerText(),
      }, null, 2))
      throw error
    })

    await requestQuitDecision(application, 2)
    await expect.poll(() => harnessWindowVisible(application!), { timeout: 10_000 }).toBe(true)
    await requestQuitDecision(application, 0)
    await expect.poll(() => harnessWindowVisible(application!), { timeout: 10_000 }).toBe(false)
    const hiddenProjection = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
    expect(hiddenProjection.tasks.filter(task => task.status === 'running').map(task => task.taskId))
      .toEqual(expect.arrayContaining([firstSession.sessionId, secondSession.sessionId]))
    await emitTrayClick(application)
    await expect.poll(() => harnessWindowVisible(application!), { timeout: 10_000 }).toBe(true)
    await overview.waitFor({ state: 'visible', timeout: 10_000 })

    const isolatedSource = join(temporaryRoot, 'isolated-source')
    await mkdir(isolatedSource)
    git(isolatedSource, ['init'])
    git(isolatedSource, ['config', 'user.name', 'DeepSeek Harness Test'])
    git(isolatedSource, ['config', 'user.email', 'test@localhost'])
    await writeFile(join(isolatedSource, 'tracked.txt'), 'clean base\n')
    git(isolatedSource, ['add', 'tracked.txt'])
    git(isolatedSource, ['commit', '-m', 'clean base'])
    const isolatedWorkspace = await pageRpc<{ workspace: { workspaceId: string } }>(
      page,
      'workspace.create',
      { path: isolatedSource },
    )
    const [isolatedFirst, isolatedSecond] = await Promise.all([
      pageRpc<{ sessionId: string; executionWorkspace: NonNullable<TaskIdentitySnapshot['tasks'][number]['executionWorkspace']> }>(
        page,
        'session.create',
        { workspaceId: isolatedWorkspace.workspace.workspaceId, isolation: 'worktree' },
      ),
      pageRpc<{ sessionId: string; executionWorkspace: NonNullable<TaskIdentitySnapshot['tasks'][number]['executionWorkspace']> }>(
        page,
        'session.create',
        { workspaceId: isolatedWorkspace.workspace.workspaceId, isolation: 'worktree' },
      ),
    ])
    expect(isolatedFirst.executionWorkspace).toMatchObject({
      kind: 'git-worktree',
      taskId: isolatedFirst.sessionId,
      workspaceId: isolatedWorkspace.workspace.workspaceId,
      sourcePath: isolatedSource,
      sourceDirty: false,
    })
    expect(isolatedSecond.executionWorkspace).toMatchObject({
      kind: 'git-worktree',
      taskId: isolatedSecond.sessionId,
      workspaceId: isolatedWorkspace.workspace.workspaceId,
      sourcePath: isolatedSource,
      sourceDirty: false,
    })
    expect(isolatedFirst.executionWorkspace.path).not.toBe(isolatedSecond.executionWorkspace.path)
    expect(isolatedFirst.executionWorkspace.branch).not.toBe(isolatedSecond.executionWorkspace.branch)
    expect(isolatedFirst.executionWorkspace.baseCommit).toBe(isolatedSecond.executionWorkspace.baseCommit)
    expect(isolatedFirst.executionWorkspace.sourceHead).toBe(isolatedFirst.executionWorkspace.baseCommit)
    expect(existsSync(join(isolatedFirst.executionWorkspace.path, 'tracked.txt'))).toBe(true)
    expect(existsSync(join(isolatedSecond.executionWorkspace.path, 'tracked.txt'))).toBe(true)
    expect(git(isolatedSource, ['status', '--porcelain=v1'])).toBe('')

    await Promise.all([
      pageRpc(page, 'session.prompt', {
        sessionId: isolatedFirst.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'run isolated task alpha' }],
      }),
      pageRpc(page, 'session.prompt', {
        sessionId: isolatedSecond.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: 'run isolated task beta' }],
      }),
    ])
    await expect.poll(async () => {
      const projection = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
      return projection.tasks
        .filter(task => task.taskId === isolatedFirst.sessionId || task.taskId === isolatedSecond.sessionId)
        .map(task => task.executionWorkspace?.path)
        .sort()
    }, { timeout: 15_000 }).toEqual([
      isolatedFirst.executionWorkspace.path,
      isolatedSecond.executionWorkspace.path,
    ].sort())
    const isolatedRows = overview.getByRole('heading', { name: /^(Running|进行中)$/u }).locator('..')
      .getByRole('listitem').filter({ hasText: 'isolated-source' })
    await expect.poll(() => isolatedRows.count(), { timeout: 15_000 }).toBe(2)
    await expect.poll(async () => (await isolatedRows.allTextContents())
      .every(row => /(Worktree|工作树)/u.test(row)), { timeout: 15_000 }).toBe(true)

    const deliverySource = join(temporaryRoot, 'review-delivery-source')
    await initializeRepository(deliverySource)
    const deliveryWorkspace = await pageRpc<{ workspace: { workspaceId: string } }>(
      page,
      'workspace.create',
      { path: deliverySource },
    )
    const delivery = await pageRpc<{
      sessionId: string
      executionWorkspace: NonNullable<TaskIdentitySnapshot['tasks'][number]['executionWorkspace']>
    }>(page, 'session.create', {
      workspaceId: deliveryWorkspace.workspace.workspaceId,
      isolation: 'worktree',
    })
    await writeFile(join(delivery.executionWorkspace.path, 'tracked.txt'), 'delivered task change\n')
    await writeFile(join(delivery.executionWorkspace.path, 'artifact.bin'), Buffer.from([0, 1, 2, 255]))
    const deliveryReady = await makeTaskReady(page, delivery.sessionId, 'Deliver reviewed desktop changes')
    const deliveryReview = await pageRpc<TaskReviewSummarySnapshot>(page, 'task.reviewSummary', {
      sessionId: delivery.sessionId,
    })
    expect(deliveryReview).toMatchObject({ dirty: true, sourceHead: delivery.executionWorkspace.sourceHead })
    expect(deliveryReview.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tracked.txt', binary: false }),
      expect.objectContaining({ path: 'artifact.bin', binary: true }),
    ]))
    const deliveredTextDiff = await pageRpc<{ binary: boolean; patch: string }>(page, 'task.reviewDiff', {
      sessionId: delivery.sessionId,
      path: 'tracked.txt',
      expectedRevision: deliveryReview.revision,
    })
    expect(deliveredTextDiff.binary).toBe(false)
    expect(deliveredTextDiff.patch).toContain('+delivered task change')
    const deliveredBinaryDiff = await pageRpc<{ binary: boolean; patch: string }>(page, 'task.reviewDiff', {
      sessionId: delivery.sessionId,
      path: 'artifact.bin',
      expectedRevision: deliveryReview.revision,
    })
    expect(deliveredBinaryDiff).toMatchObject({ binary: true, patch: '' })
    const deliveryCommitted = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.commit', {
      sessionId: delivery.sessionId,
      expectedRevision: deliveryReview.revision,
      message: 'feat: deliver desktop review',
      expectedSeq: deliveryReady.asOfSeq,
    })
    expect(deliveryCommitted.commitReceipt?.commit).toMatch(/^[0-9a-f]{40}$/u)
    const deliveryApplied = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.apply', {
      sessionId: delivery.sessionId,
      expectedRevision: deliveryCommitted.commitReceipt?.committedRevision,
      expectedSourceHead: deliveryReview.sourceHead,
      commit: deliveryCommitted.commitReceipt?.commit,
      expectedSeq: deliveryCommitted.asOfSeq,
    })
    expect(deliveryApplied.applyReceipt).toMatchObject({
      commit: deliveryCommitted.commitReceipt?.commit,
      sourceHeadBefore: deliveryReview.sourceHead,
      sourceHeadAfter: deliveryReview.sourceHead,
    })
    expect(await readFile(join(deliverySource, 'tracked.txt'), 'utf8')).toBe('delivered task change\n')
    expect(await readFile(join(deliverySource, 'artifact.bin'))).toEqual(Buffer.from([0, 1, 2, 255]))
    expect(git(deliverySource, ['rev-parse', 'HEAD']).trim()).toBe(deliveryReview.sourceHead)

    const conflictSource = join(temporaryRoot, 'review-conflict-source')
    await initializeRepository(conflictSource)
    const conflictWorkspace = await pageRpc<{ workspace: { workspaceId: string } }>(
      page,
      'workspace.create',
      { path: conflictSource },
    )
    const conflict = await pageRpc<{
      sessionId: string
      executionWorkspace: NonNullable<TaskIdentitySnapshot['tasks'][number]['executionWorkspace']>
    }>(page, 'session.create', {
      workspaceId: conflictWorkspace.workspace.workspaceId,
      isolation: 'worktree',
    })
    await writeFile(join(conflict.executionWorkspace.path, 'tracked.txt'), 'task side\n')
    const conflictReady = await makeTaskReady(page, conflict.sessionId, 'Reject conflicting delivery')
    const conflictReview = await pageRpc<TaskReviewSummarySnapshot>(page, 'task.reviewSummary', {
      sessionId: conflict.sessionId,
    })
    const conflictCommitted = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.commit', {
      sessionId: conflict.sessionId,
      expectedRevision: conflictReview.revision,
      message: 'feat: conflicting desktop review',
      expectedSeq: conflictReady.asOfSeq,
    })
    await writeFile(join(conflictSource, 'tracked.txt'), 'source side\n')
    git(conflictSource, ['add', 'tracked.txt'])
    git(conflictSource, ['commit', '-m', 'source side'])
    const conflictAfterSourceMove = await pageRpc<TaskReviewSummarySnapshot>(page, 'task.reviewSummary', {
      sessionId: conflict.sessionId,
    })
    const conflictBefore = {
      head: git(conflictSource, ['rev-parse', 'HEAD']).trim(),
      index: git(conflictSource, ['diff', '--cached', '--binary']),
      status: git(conflictSource, ['status', '--porcelain=v1', '-z']),
      text: await readFile(join(conflictSource, 'tracked.txt'), 'utf8'),
    }
    const conflictOutcome = await pageRpcOutcome(page, 'task.apply', {
      sessionId: conflict.sessionId,
      expectedRevision: conflictCommitted.commitReceipt?.committedRevision,
      expectedSourceHead: conflictAfterSourceMove.sourceHead,
      commit: conflictCommitted.commitReceipt?.commit,
      expectedSeq: conflictCommitted.asOfSeq,
    })
    expect(conflictOutcome).toMatchObject({
      ok: false,
      error: { code: 'task-review-rejected', details: { reviewCode: 'REVIEW_APPLY_CONFLICT' } },
    })
    expect({
      head: git(conflictSource, ['rev-parse', 'HEAD']).trim(),
      index: git(conflictSource, ['diff', '--cached', '--binary']),
      status: git(conflictSource, ['status', '--porcelain=v1', '-z']),
      text: await readFile(join(conflictSource, 'tracked.txt'), 'utf8'),
    }).toEqual(conflictBefore)

    const discardSource = join(temporaryRoot, 'review-discard-source')
    await initializeRepository(discardSource)
    const discardWorkspace = await pageRpc<{ workspace: { workspaceId: string } }>(
      page,
      'workspace.create',
      { path: discardSource },
    )
    const discard = await pageRpc<{
      sessionId: string
      executionWorkspace: NonNullable<TaskIdentitySnapshot['tasks'][number]['executionWorkspace']>
    }>(page, 'session.create', {
      workspaceId: discardWorkspace.workspace.workspaceId,
      isolation: 'worktree',
    })
    await writeFile(join(discard.executionWorkspace.path, 'tracked.txt'), 'recoverable committed task\n')
    const discardReady = await makeTaskReady(page, discard.sessionId, 'Discard delivered worktree safely')
    const discardReview = await pageRpc<TaskReviewSummarySnapshot>(page, 'task.reviewSummary', {
      sessionId: discard.sessionId,
    })
    const discardCommitted = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.commit', {
      sessionId: discard.sessionId,
      expectedRevision: discardReview.revision,
      message: 'feat: preserve discarded branch',
      expectedSeq: discardReady.asOfSeq,
    })
    const discarded = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.discard', {
      sessionId: discard.sessionId,
      expectedRevision: discardCommitted.commitReceipt?.committedRevision,
      confirmedUncommittedLoss: false,
      expectedSeq: discardCommitted.asOfSeq,
    })
    expect(discarded.discardReceipt).toMatchObject({
      branch: discard.executionWorkspace.branch,
      branchPreserved: true,
      worktreeRemoved: true,
      recoverableCommit: discardCommitted.commitReceipt?.commit,
    })
    expect(existsSync(discard.executionWorkspace.path)).toBe(false)
    expect(git(discardSource, ['show-ref', '--verify', `refs/heads/${discard.executionWorkspace.branch}`]).trim())
      .toContain(discardCommitted.commitReceipt?.commit)
    await overview.getByText('workspace-a').locator('xpath=ancestor::li').getByRole('button').first().click()
    await overview.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /^(Tasks|任务)$/u }).click()
    await overview.waitFor({ state: 'visible' })
    await expectBothWorkspacesRunning(overview)
    await overview.getByText('workspace-b').locator('xpath=ancestor::li').getByRole('button').first().click()
    await overview.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: /^(Tasks|任务)$/u }).click()
    await overview.waitFor({ state: 'visible' })
    await expectBothWorkspacesRunning(overview)

    const establishedSocketCount = await disconnectHarnessSockets(page)
    await overview.getByText(/^(Disconnected; displayed information may be out of date\.|连接已断开；已显示的信息可能已过时。)$/u)
      .waitFor({ state: 'visible', timeout: 10_000 })
    await expectBothWorkspacesRunning(overview)
    await resumeHarnessSockets(page)
    await expect.poll(() => harnessSocketOpenCount(page), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(establishedSocketCount + 2)
    await overview.getByText(/^(Disconnected; displayed information may be out of date\.|连接已断开；已显示的信息可能已过时。)$/u)
      .waitFor({ state: 'hidden', timeout: 15_000 })
    await overview.getByRole('status').waitFor({ state: 'hidden', timeout: 15_000 })
    expect(await overview.getByRole('alert').count()).toBe(0)
    await expectBothWorkspacesRunning(overview)

    const workspaceC = join(temporaryRoot, 'workspace-c')
    await mkdir(workspaceC)
    const thirdWorkspace = await pageRpc<{ workspace: { workspaceId: string } }>(
      page,
      'workspace.create',
      { path: workspaceC },
    )
    const thirdSession = await pageRpc<{ sessionId: string }>(page, 'session.create', {
      workspaceId: thirdWorkspace.workspace.workspaceId,
    })
    await pageRpc(page, 'session.prompt', {
      sessionId: thirdSession.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: DESCENDANT_PARENT_PROMPT }],
    })
    await expect.poll(() => observedParentPrompt, { timeout: 10_000 }).toBe(true)
    await expect.poll(() => observedChildPrompt, { timeout: 10_000 }).toBe(true)
    const needsYou = overview.getByRole('heading', { name: /^(Needs You|需要你处理)$/u }).locator('..')
    await expect.poll(() => needsYou.innerText(), { timeout: 20_000 }).toContain(DESCENDANT_CHILD_PROMPT)
    const childQuestion = needsYou.getByRole('button', { name: DESCENDANT_QUESTION_NAME })
    await childQuestion.waitFor({ state: 'visible', timeout: 20_000 })
    const beforeReload = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
    const beforeTask = beforeReload.tasks.find(task => task.taskId === thirdSession.sessionId)
    const beforeAttention = beforeTask?.attention.find(item => item.summary === DESCENDANT_QUESTION)
    expect(beforeTask).toBeDefined()
    expect(beforeAttention).toBeDefined()

    await page.reload({ waitUntil: 'load' })
    await overview.waitFor({ state: 'visible', timeout: 15_000 })
    const afterReload = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
    const afterTask = afterReload.tasks.find(task => task.taskId === thirdSession.sessionId)
    const afterAttention = afterTask?.attention.find(item => item.summary === DESCENDANT_QUESTION)
    expect(afterTask?.taskId).toBe(beforeTask?.taskId)
    expect(afterAttention?.id).toBe(beforeAttention?.id)
    expect(afterAttention?.ownerSessionId).toBe(beforeAttention?.ownerSessionId)
    for (const created of [isolatedFirst, isolatedSecond]) {
      const restored = afterReload.tasks.find(task => task.taskId === created.sessionId)
      expect(restored?.workspaceId).toBe(isolatedWorkspace.workspace.workspaceId)
      expect(restored?.executionWorkspace).toEqual(created.executionWorkspace)
    }
    expect(afterReload.tasks.find(task => task.taskId === delivery.sessionId)?.applyReceipt)
      .toEqual(deliveryApplied.applyReceipt)
    expect(afterReload.tasks.find(task => task.taskId === discard.sessionId)?.discardReceipt)
      .toEqual(discarded.discardReceipt)

    const reloadedNeedsYou = overview.getByRole('heading', { name: /^(Needs You|需要你处理)$/u }).locator('..')
    const reloadedChildQuestion = reloadedNeedsYou.getByRole('button', { name: DESCENDANT_QUESTION_NAME })
    await reloadedChildQuestion.waitFor({ state: 'visible', timeout: 20_000 })
    await page.evaluate(() => {
      const target = globalThis as unknown as {
        __dshObservedDesktopTarget?: string
        deepseekDesktop: { onOpenSession(listener: (sessionId: string) => void): () => void }
      }
      target.deepseekDesktop.onOpenSession((sessionId) => { target.__dshObservedDesktopTarget = sessionId })
    })
    await expect.poll(async () => (await nativeAcceptanceSnapshot(application!)).notificationBodies, { timeout: 20_000 })
      .toContain(DESCENDANT_QUESTION)
    await emitNotificationClick(application, DESCENDANT_QUESTION)
    await expect.poll(() => page.evaluate(() => (
      globalThis as unknown as { __dshObservedDesktopTarget?: string }
    ).__dshObservedDesktopTarget), { timeout: 10_000 }).toBe(afterAttention?.ownerSessionId)
    await overview.waitFor({ state: 'hidden', timeout: 10_000 }).catch(async (error: unknown) => {
      const diagnostics = {
        native: await nativeAcceptanceSnapshot(application!),
        overview: await overview.innerText(),
        target: await page.evaluate(() => (
          globalThis as unknown as { __dshObservedDesktopTarget?: string }
        ).__dshObservedDesktopTarget),
      }
      const log = await readFile(join(environment.APPDATA!, 'DeepSeek Harness', 'logs', 'desktop.log'), 'utf8')
      await writeFile(join(screenshots, 'task-notification-navigation.json'), JSON.stringify(diagnostics, null, 2))
      await writeFile(join(screenshots, 'task-notification-navigation.log'), log)
      throw error
    })
    await page.getByText(DESCENDANT_QUESTION, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })

    const origin = new URL(page.url()).origin
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    const unauthorized = await fetch(`${origin}/api/host.describe`, hostDescribeRequest())
    expect(unauthorized.status).toBe(401)

    const authorization = captureAuthorization(page)
    const authorized = await page.evaluate(async () => {
      const response = await fetch('/api/host.describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      return { body: await response.json() as unknown, status: response.status }
    })
    expect(authorized.status).toBe(200)
    if (authorized.body === null || typeof authorized.body !== 'object') {
      throw new Error('authorized host.describe response must be an object')
    }
    expect(authorized.body).toHaveProperty('result')

    const bearer = await authorization
    expect(bearer).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/u)
    const capability = bearer.slice('Bearer '.length)
    const renderer = await inspectRenderer(page)
    expect(renderer.processType).toBe('undefined')
    expect(renderer.requireType).toBe('undefined')
    expect(renderer.bridge).toEqual({ frozen: true, keys: ['onOpenSession', 'platform'], platform: process.platform })
    expect(renderer.location).not.toContain(capability)
    expect(renderer.dom).not.toContain(capability)
    expect(renderer.globalStrings).not.toContain(capability)
    expect(renderer.localStorage).not.toContain(capability)
    expect(renderer.sessionStorage).not.toContain(capability)
    expect(JSON.stringify(renderer.bridge)).not.toContain(capability)

    const durableBeforeCrash = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
    const taskIdsBeforeCrash = durableBeforeCrash.tasks.map(task => task.taskId).sort()
    const targetAttentionBeforeCrash = durableBeforeCrash.tasks
      .find(task => task.taskId === thirdSession.sessionId)?.attention.map(attention => attention.id).sort()
    if (beforeAttention === undefined || targetAttentionBeforeCrash === undefined) {
      throw new Error('Expected the descendant question to remain pending before the Host crash')
    }
    expect(targetAttentionBeforeCrash).toEqual([beforeAttention.id])
    const questionDispatchesBeforeCrash = descendantQuestionDispatchCount
    const launchesBeforeCrash = (await nativeAcceptanceSnapshot(application)).harnessLaunchCount
    expect(launchesBeforeCrash).toBe(1)

    await terminateCurrentHarness(application)
    const recovery = await waitForWindow(application, window => window.url().startsWith('file:'))
    await recovery.waitForLoadState('load')
    await recovery.getByText('Retry startup. If the problem continues, open the desktop log.').waitFor({
      state: 'visible',
      timeout: 15_000,
    })
    await new Promise(resolve => setTimeout(resolve, 500))
    expect((await nativeAcceptanceSnapshot(application)).harnessLaunchCount).toBe(launchesBeforeCrash)

    await recovery.getByRole('button', { name: 'Retry' }).click()
    page = await waitForWindow(application, window => /^http:\/\/127\.0\.0\.1:\d+\//u.test(window.url()))
    await page.waitForLoadState('load')
    await expect.poll(async () => page.locator('#root').innerHTML(), { timeout: 15_000 }).not.toBe('')
    expect((await nativeAcceptanceSnapshot(application)).harnessLaunchCount).toBe(launchesBeforeCrash + 1)

    const recoveredAuthorization = captureAuthorization(page)
    await page.evaluate(async () => {
      await fetch('/api/host.describe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    })
    expect(await recoveredAuthorization).not.toBe(bearer)
    const durableAfterCrash = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
    const taskIdsAfterCrash = durableAfterCrash.tasks.map(task => task.taskId)
    for (const taskId of taskIdsBeforeCrash) expect(taskIdsAfterCrash).toContain(taskId)
    await expect.poll(async () => (await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})).tasks
      .find(task => task.taskId === thirdSession.sessionId)?.attention.find(attention => (
        attention.ownerSessionId === beforeAttention.ownerSessionId && attention.kind === 'run-failure'
      )), {
      timeout: 15_000,
    }).toMatchObject({
      kind: 'run-failure',
      ownerSessionId: beforeAttention.ownerSessionId,
      summary: 'This Task was interrupted before the turn completed. Review the last tool result before continuing.',
    })
    expect((await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})).tasks
      .find(task => task.taskId === thirdSession.sessionId)?.attention.map(attention => attention.id))
      .not.toContain(targetAttentionBeforeCrash[0])
    expect(descendantQuestionDispatchCount).toBe(questionDispatchesBeforeCrash)

    await page.close()
    await expect.poll(() => application?.windows().length, { timeout: 10_000 }).toBe(0)
    const nativeBeforeBackgroundCrash = await nativeAcceptanceSnapshot(application)
    await terminateCurrentHarness(application)
    const backgroundRecovery = await waitForWindow(application, window => window.url().startsWith('file:'))
    await backgroundRecovery.getByRole('button', { name: 'Retry' }).waitFor({ state: 'visible', timeout: 15_000 })
    const nativeAfterBackgroundCrash = await nativeAcceptanceSnapshot(application)
    expect(nativeAfterBackgroundCrash.harnessLaunchCount).toBe(launchesBeforeCrash + 1)
    expect(nativeAfterBackgroundCrash.notificationBodies).toEqual(nativeBeforeBackgroundCrash.notificationBodies)
    expect(nativeAfterBackgroundCrash.trayReady).toBe(false)

    await backgroundRecovery.getByRole('button', { name: 'Retry' }).click()
    page = await waitForWindow(application, window => /^http:\/\/127\.0\.0\.1:\d+\//u.test(window.url()))
    await page.waitForLoadState('load')
    await expect.poll(async () => page.locator('#root').innerHTML(), { timeout: 15_000 }).not.toBe('')
    expect((await nativeAcceptanceSnapshot(application)).harnessLaunchCount).toBe(launchesBeforeCrash + 2)
    const taskIdsAfterBackgroundCrash = (await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})).tasks
      .map(task => task.taskId)
    for (const taskId of taskIdsBeforeCrash) expect(taskIdsAfterBackgroundCrash).toContain(taskId)

    const closing = application
    const closed = closing.waitForEvent('close')
    await requestQuitDecision(closing, 1)
    await closed
    application = undefined
    releaseProvider()
  }, 180_000)
})

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function initializeRepository(path: string): Promise<void> {
  await mkdir(path)
  git(path, ['init'])
  git(path, ['config', 'core.autocrlf', 'false'])
  git(path, ['config', 'user.name', 'DeepSeek Harness Test'])
  git(path, ['config', 'user.email', 'test@localhost'])
  await writeFile(join(path, 'tracked.txt'), 'clean base\n')
  git(path, ['add', 'tracked.txt'])
  git(path, ['commit', '-m', 'clean base'])
}

async function makeTaskReady(page: Page, sessionId: string, goal: string): Promise<TaskIdentitySnapshot['tasks'][number]> {
  const snapshot = await pageRpc<TaskIdentitySnapshot>(page, 'task.list', {})
  const current = snapshot.tasks.find(task => task.taskId === sessionId)
  if (current === undefined) throw new Error(`Task ${sessionId} was not projected`)
  const defined = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.define', {
    sessionId,
    goal,
    criteria: [{ text: 'The reviewed change is ready for delivery' }],
    expectedSeq: current.asOfSeq,
  })
  const criterion = defined.definition?.criteria[0]
  if (criterion === undefined) throw new Error(`Task ${sessionId} did not retain its acceptance criterion`)
  const satisfied = await pageRpc<TaskIdentitySnapshot['tasks'][number]>(page, 'task.updateCriterion', {
    sessionId,
    criterion: {
      ...criterion,
      status: 'satisfied',
      evidence: [{ sessionId, seq: 0 }],
    },
    expectedSeq: defined.asOfSeq,
  })
  return pageRpc(page, 'task.review', {
    sessionId,
    decision: 'ready',
    expectedSeq: satisfied.asOfSeq,
  })
}

async function readProviderRequest(request: IncomingMessage): Promise<unknown> {
  let body = ''
  for await (const chunk of request) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
  return JSON.parse(body) as unknown
}

function providerMessageText(body: unknown): string {
  if (body === null || typeof body !== 'object' || !('messages' in body)) return ''
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return ''
  return messages.map((message) => {
    if (message === null || typeof message !== 'object' || !('content' in message)) return ''
    const content = (message as { content?: unknown }).content
    return typeof content === 'string' ? content : JSON.stringify(content)
  }).join('\n')
}

function providerHasTool(body: unknown, name: string): boolean {
  if (body === null || typeof body !== 'object' || !('tools' in body)) return false
  const tools = (body as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return false
  return tools.some((tool) => {
    if (tool === null || typeof tool !== 'object' || !('function' in tool)) return false
    const definition = (tool as { function?: unknown }).function
    return definition !== null && typeof definition === 'object' && 'name' in definition
      && (definition as { name?: unknown }).name === name
  })
}

function providerHasToolResult(body: unknown): boolean {
  if (body === null || typeof body !== 'object' || !('messages' in body)) return false
  const messages = (body as { messages?: unknown }).messages
  return Array.isArray(messages) && messages.some(message => message !== null && typeof message === 'object'
    && 'role' in message && (message as { role?: unknown }).role === 'tool')
}

function textCompletionEvents(text: string): string[] {
  return [
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    JSON.stringify({ choices: [{ delta: { content: text } }] }),
    '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    '[DONE]',
  ]
}

function toolCallEvents(id: string, name: string, args: unknown): string[] {
  return [
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    JSON.stringify({
      choices: [{
        delta: {
          tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
        },
      }],
    }),
    '{"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
    '[DONE]',
  ]
}

function sendProviderEvents(response: ServerResponse, events: string[]): void {
  if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end([...events.map(event => `data: ${event}`), ''].join('\n\n'))
}

const HARNESS_SOCKET_PROBE = `(() => {
  const NativeWebSocket = globalThis.WebSocket
  const control = { block: false, openCount: 0, sockets: [] }
  const HarnessWebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const requested = new URL(String(args[0]), location.href)
      const harness = requested.pathname === '/api/events.mux' || requested.pathname === '/api/events.host'
      if (harness && control.block) {
        requested.hostname = '127.0.0.1'
        requested.port = '1'
        args[0] = requested.href
      }
      const socket = Reflect.construct(target, args)
      if (harness) {
        control.sockets.push(socket)
        if (!control.block) socket.addEventListener('open', () => { control.openCount += 1 }, { once: true })
      }
      return socket
    },
  })
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: HarnessWebSocket })
  Object.defineProperty(globalThis, '__dshHarnessSocketControl', { configurable: true, value: control })
})()`

async function disconnectHarnessSockets(page: Page): Promise<number> {
  return page.evaluate(() => {
    const control = (globalThis as unknown as {
      __dshHarnessSocketControl: { block: boolean; openCount: number; sockets: WebSocket[] }
    }).__dshHarnessSocketControl
    control.block = true
    for (const socket of control.sockets) {
      if (socket.readyState === WebSocket.OPEN) socket.close(4100, 'desktop reconnect acceptance')
    }
    return control.openCount
  })
}

async function resumeHarnessSockets(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = (globalThis as unknown as {
      __dshHarnessSocketControl: { block: boolean }
    }).__dshHarnessSocketControl
    control.block = false
  })
}

async function harnessSocketOpenCount(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as unknown as {
    __dshHarnessSocketControl: { openCount: number }
  }).__dshHarnessSocketControl.openCount)
}

function hostDescribeRequest(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }
}

async function pageRpc<T>(page: Page, method: string, payload: unknown): Promise<T> {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `desktop-${method}-${crypto.randomUUID()}`, method, payload }),
    })
    const body = await response.json() as { result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } } }
    if (!response.ok) throw new Error(`${method} failed over HTTP ${String(response.status)}`)
    if (!body.result.ok) throw new Error(`${method} failed: ${body.result.error.code}: ${body.result.error.message}`)
    return body.result.value
  }, { method, payload })
}

async function pageRpcOutcome(
  page: Page,
  method: string,
  payload: unknown,
): Promise<{ readonly ok: true; readonly value: unknown } | {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string; readonly details?: unknown }
}> {
  return page.evaluate(async ({ method, payload }) => {
    const response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `desktop-${method}-${crypto.randomUUID()}`, method, payload }),
    })
    const body = await response.json() as { result: {
      ok: true
      value: unknown
    } | {
      ok: false
      error: { code: string; message: string; details?: unknown }
    } }
    if (!response.ok) throw new Error(`${method} failed over HTTP ${String(response.status)}`)
    return body.result
  }, { method, payload })
}

async function expectBothWorkspacesRunning(overview: Locator): Promise<void> {
  const running = overview.getByRole('heading', { name: /^(Running|进行中)$/u }).locator('..')
  await expect.poll(async () => Promise.all(
    ['workspace-a', 'workspace-b'].map(name => running.getByRole('listitem').filter({ hasText: name }).count()),
  ), { timeout: 15_000 }).toEqual([1, 1])
}

function captureAuthorization(page: Page): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('request', onRequest)
      reject(new Error('authorized host.describe request was not observed'))
    }, 10_000)
    const onRequest = (request: Request): void => {
      if (!request.url().endsWith('/api/host.describe')) return
      void request.allHeaders().then((headers) => {
        const value = headers.authorization
        if (value === undefined) {
          clearTimeout(timer)
          page.off('request', onRequest)
          reject(new Error('desktop authorization header was absent from the renderer request'))
          return
        }
        clearTimeout(timer)
        page.off('request', onRequest)
        resolve(value)
      }, reject)
    }
    page.on('request', onRequest)
  })
}

async function inspectRenderer(page: Page): Promise<{
  readonly bridge: { readonly frozen: boolean; readonly keys: string[]; readonly platform: string }
  readonly dom: string
  readonly globalStrings: string
  readonly localStorage: string
  readonly location: string
  readonly processType: string
  readonly requireType: string
  readonly sessionStorage: string
}> {
  return page.evaluate(() => {
    const bridge = (globalThis as unknown as {
      readonly deepseekDesktop: Readonly<{
        readonly platform: string
        readonly onOpenSession: (listener: (sessionId: string) => void) => () => void
      }>
    }).deepseekDesktop
    const globalStrings = Object.getOwnPropertyNames(globalThis).flatMap((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
      return typeof descriptor?.value === 'string' ? [descriptor.value] : []
    }).join('\n')
    const serializeStorage = (storage: Storage): string => JSON.stringify(
      Array.from({ length: storage.length }, (_value, index) => {
        const key = storage.key(index)
        return key === null ? null : [key, storage.getItem(key)]
      }),
    )
    return {
      bridge: {
        frozen: Object.isFrozen(bridge),
        keys: Object.keys(bridge).sort(),
        platform: bridge.platform,
      },
      dom: document.documentElement.outerHTML,
      globalStrings,
      localStorage: serializeStorage(localStorage),
      location: location.href,
      processType: typeof (globalThis as unknown as { process?: unknown }).process,
      requireType: typeof (globalThis as unknown as { require?: unknown }).require,
      sessionStorage: serializeStorage(sessionStorage),
    }
  })
}

async function waitForWindow(target: ElectronApplication, predicate: (window: Page) => boolean): Promise<Page> {
  let matched: Page | undefined
  await expect.poll(() => {
    matched = target.windows().find(predicate)
    return matched !== undefined
  }, { timeout: 75_000 }).toBe(true)
  if (matched === undefined) throw new Error('Expected Electron window did not open')
  return matched
}

async function terminateCurrentHarness(target: ElectronApplication): Promise<void> {
  await target.evaluate(() => {
    const state = (globalThis as unknown as {
      readonly __dshDesktopNativeAcceptance?: {
        readonly harnessProcesses: readonly { kill(): boolean }[]
      }
    }).__dshDesktopNativeAcceptance
    const child = state?.harnessProcesses.at(-1)
    if (child === undefined) throw new Error('desktop Harness utility process is unavailable')
    if (!child.kill()) throw new Error('desktop Harness utility process rejected termination')
  })
}

interface NativeAcceptanceSnapshot {
  readonly dialogButtons: readonly (readonly string[])[]
  readonly dialogCallCount: number
  readonly harnessLaunchCount: number
  readonly notificationBodies: readonly string[]
  readonly trayReady: boolean
  readonly trayToolTip: string
}

async function nativeAcceptanceSnapshot(target: ElectronApplication): Promise<NativeAcceptanceSnapshot> {
  return target.evaluate(() => {
    const state = (globalThis as unknown as {
      readonly __dshDesktopNativeAcceptance?: {
        readonly activeTrays: ReadonlySet<unknown>
        readonly dialogCalls: readonly { readonly buttons?: readonly string[] }[]
        readonly harnessProcesses: readonly unknown[]
        readonly notifications: readonly { readonly body: string }[]
        readonly tray?: unknown
        readonly trayToolTip: string
      }
    }).__dshDesktopNativeAcceptance
    if (state === undefined) throw new Error('desktop native acceptance instrumentation is unavailable')
    return {
      dialogButtons: state.dialogCalls.map(call => call.buttons ?? []),
      dialogCallCount: state.dialogCalls.length,
      harnessLaunchCount: state.harnessProcesses.length,
      notificationBodies: state.notifications.map(notification => notification.body),
      trayReady: state.activeTrays.size > 0,
      trayToolTip: state.trayToolTip,
    }
  })
}

async function emitTrayClick(target: ElectronApplication): Promise<void> {
  await target.evaluate(() => {
    const state = (globalThis as unknown as {
      readonly __dshDesktopNativeAcceptance?: { readonly trayListeners: { readonly click?: () => void } }
    }).__dshDesktopNativeAcceptance
    if (state?.trayListeners.click === undefined) throw new Error('desktop tray click listener is unavailable')
    state.trayListeners.click()
  })
}

async function emitNotificationClick(target: ElectronApplication, body: string): Promise<void> {
  await target.evaluate((_electron, expectedBody) => {
    const state = (globalThis as unknown as {
      readonly __dshDesktopNativeAcceptance?: {
        readonly notifications: readonly { readonly body: string; readonly listeners: { readonly click?: () => void } }[]
      }
    }).__dshDesktopNativeAcceptance
    const entry = state?.notifications.findLast(notification => notification.body === expectedBody)
    if (entry === undefined) throw new Error(`desktop notification is unavailable: ${expectedBody}`)
    if (entry.listeners.click === undefined) throw new Error(`desktop notification click listener is unavailable: ${expectedBody}`)
    entry.listeners.click()
  }, body)
}

async function requestQuitDecision(target: ElectronApplication, response: 0 | 1 | 2): Promise<void> {
  const before = await nativeAcceptanceSnapshot(target)
  await target.evaluate(({ app }, queuedResponse) => {
    const state = (globalThis as unknown as {
      readonly __dshDesktopNativeAcceptance?: { readonly dialogResponses: number[] }
    }).__dshDesktopNativeAcceptance
    if (state === undefined) throw new Error('desktop quit acceptance instrumentation is unavailable')
    state.dialogResponses.push(queuedResponse)
    app.quit()
  }, response)
  if (response === 1) return
  await expect.poll(async () => (await nativeAcceptanceSnapshot(target)).dialogCallCount, { timeout: 10_000 })
    .toBe(before.dialogCallCount + 1)
  const after = await nativeAcceptanceSnapshot(target)
  expect(after.dialogButtons.at(-1)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^(Continue in Background|继续后台运行)$/u),
    expect.stringMatching(/^(Stop and Quit|停止并退出)$/u),
    expect.stringMatching(/^(Cancel|取消)$/u),
  ]))
}

async function harnessWindowVisible(target: ElectronApplication): Promise<boolean> {
  return target.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => (
    /^http:\/\/127\.0\.0\.1:\d+\//u.test(window.webContents.getURL()) && window.isVisible()
  )))
}

async function isolatedEnvironment(root: string): Promise<Record<string, string>> {
  const environment = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => {
    return value === undefined || SENSITIVE_ENVIRONMENT_KEY.test(key) ? [] : [[key, value]]
  }))
  const home = join(root, 'home')
  const roaming = join(root, 'appdata', 'roaming')
  const local = join(root, 'appdata', 'local')
  const temp = join(root, 'temp')
  await Promise.all([home, roaming, local, temp].map(path => mkdir(path, { recursive: true })))
  return {
    ...environment,
    APPDATA: roaming,
    DSH_HOME: join(home, '.dsh'),
    LOCALAPPDATA: local,
    TEMP: temp,
    TMP: temp,
  }
}

async function boundedClose(target: ElectronApplication): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await target.evaluate(({ app }) => {
      const state = (globalThis as unknown as {
        readonly __dshDesktopNativeAcceptance?: { readonly dialogResponses: number[] }
      }).__dshDesktopNativeAcceptance
      state?.dialogResponses.push(1)
      app.quit()
    }).catch(() => {})
    await Promise.race([
      target.close(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Electron and its utility process did not close within 15s'))
        }, 15_000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
