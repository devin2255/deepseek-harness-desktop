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
    readonly attention: readonly {
      readonly id: string
      readonly ownerSessionId: string
      readonly summary: string
    }[]
  }[]
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
      "import { app } from 'electron'",
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
    const page = mainWindow
    if (page === undefined) throw new Error('The authorized desktop window did not open')
    await page.waitForLoadState('load')
    await page.addInitScript({ content: HARNESS_SOCKET_PROBE })
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => application?.windows().length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.title(), { timeout: 10_000 }).toBe('DeepSeek Harness')
    await expect.poll(async () => page.locator('#root').innerHTML(), { timeout: 10_000 })
      .not.toBe('')

    const overview = page.getByRole('main', { name: /^(Tasks|任务)$/u })
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

    const reloadedNeedsYou = overview.getByRole('heading', { name: /^(Needs You|需要你处理)$/u }).locator('..')
    const reloadedChildQuestion = reloadedNeedsYou.getByRole('button', { name: DESCENDANT_QUESTION_NAME })
    await reloadedChildQuestion.waitFor({ state: 'visible', timeout: 20_000 })
    await reloadedChildQuestion.click()
    await overview.waitFor({ state: 'hidden' })
    await page.getByText(DESCENDANT_QUESTION, { exact: true }).waitFor({ state: 'visible', timeout: 10_000 })

    releaseProvider()

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
    expect(renderer.bridge).toEqual({ frozen: true, keys: ['platform'], platform: process.platform })
    expect(renderer.location).not.toContain(capability)
    expect(renderer.dom).not.toContain(capability)
    expect(renderer.globalStrings).not.toContain(capability)
    expect(renderer.localStorage).not.toContain(capability)
    expect(renderer.sessionStorage).not.toContain(capability)
    expect(JSON.stringify(renderer.bridge)).not.toContain(capability)

    const closing = application
    await boundedClose(closing)
    application = undefined
  }, 120_000)
})

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
      readonly deepseekDesktop: Readonly<{ readonly platform: string }>
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
