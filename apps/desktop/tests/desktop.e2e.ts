import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page, type Request } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'

const DESKTOP_ROOT = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))
const SENSITIVE_ENVIRONMENT_KEY = /KEY|SECRET|TOKEN|PASSWORD/iu

let application: ElectronApplication | undefined
let temporaryRoot: string | undefined

afterEach(async () => {
  const failures: unknown[] = []
  if (application !== undefined) {
    await boundedClose(application).catch((error: unknown) => failures.push(error))
    application = undefined
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
    }, { timeout: 75_000 }).toBe(true)
    const page = mainWindow
    if (page === undefined) throw new Error('The authorized desktop window did not open')
    await page.waitForLoadState('load')
    await expect.poll(() => application?.windows().length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => page.title(), { timeout: 10_000 }).toBe('DeepSeek Harness')
    await expect.poll(async () => page.locator('#root').innerHTML(), { timeout: 10_000 })
      .not.toBe('')

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

function hostDescribeRequest(): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }
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
