import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MessageBoxOptions } from 'electron'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BackgroundPresence, BackgroundPresenceOptions } from '../src/background-presence.ts'
import type { DesktopMainDependencies, DesktopMainHandle } from '../src/main-lifecycle.ts'
import type { TaskObserver, TaskObserverOptions, TaskObserverState } from '../src/task-observer.ts'
import { UNINSTALL_CLEANUP_ENVIRONMENT_KEY } from '../src/uninstall-cleanup.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'
const originalArgv = process.argv
const originalAppData = process.env.APPDATA
const originalToken = process.env[UNINSTALL_CLEANUP_ENVIRONMENT_KEY]
const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')

afterEach(() => {
  process.argv = originalArgv
  setEnvironment('APPDATA', originalAppData)
  setEnvironment(UNINSTALL_CLEANUP_ENVIRONMENT_KEY, originalToken)
  if (originalResourcesPath === undefined) Reflect.deleteProperty(process, 'resourcesPath')
  else Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('desktop Main cleanup entry', () => {
  it('exits zero after cleanup without composing any normal desktop operation', async () => {
    const setup = prepareEntry([`--uninstall-delete-user-data=${TOKEN}`], TOKEN)
    mkdirSync(join(setup.appData, 'DeepSeek Harness'))

    await import('../src/main.ts')
    await vi.waitFor(() => { expect(setup.exit).toHaveBeenCalledWith(0) })

    assertNormalCompositionUnused(setup)
  })

  it('exits nonzero for malformed authorization without leaking tokens or composing the desktop', async () => {
    const otherToken = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh012345678'
    const setup = prepareEntry([`--uninstall-delete-user-data=${TOKEN}`], otherToken)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('../src/main.ts')
    await vi.waitFor(() => { expect(setup.exit).toHaveBeenCalledWith(1) })

    assertNormalCompositionUnused(setup)
    expect(String(consoleError.mock.calls)).not.toContain(TOKEN)
    expect(String(consoleError.mock.calls)).not.toContain(otherToken)
  })

  it('exits nonzero for a malformed persistent cleanup archive without composing the desktop', async () => {
    const setup = prepareEntry([`--uninstall-delete-user-data=${TOKEN}`], TOKEN)
    const product = join(setup.appData, 'DeepSeek Harness')
    const archive = join(setup.appData, '.DeepSeek Harness.uninstall-archive-0123456789abcdef0123456789abcdef')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(archive, Buffer.from('DSHUA0020123456789abcdef0123456789abcdef'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('../src/main.ts')
    await vi.waitFor(() => { expect(setup.exit).toHaveBeenCalledWith(1) })

    assertNormalCompositionUnused(setup)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(archive).length).toBeGreaterThan(0)
  })
})

describe('desktop Main installer close entry', () => {
  it.skipIf(process.platform !== 'win32')('authenticates the E2E appData directory before forwarding the close notification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-installer-e2e-'))
    try {
      const appData = join(root, 'appdata', 'roaming')
      mkdirSync(appData, { recursive: true })
      mkdirSync(join(root, 'home'))
      writeFileSync(join(root, '.dsh-installer-e2e-owner'), `${TOKEN}\n`)
      const setup = prepareEntry([
        '--installer-request-close', `--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${TOKEN}`,
      ], '')
      vi.stubEnv('DSH_INSTALLER_E2E', '1')
      vi.stubEnv('DSH_INSTALLER_E2E_ROOT', root)
      vi.stubEnv('DSH_INSTALLER_E2E_OWNERSHIP', TOKEN)

      await import('../src/main.ts')

      expect(setup.setPath).toHaveBeenCalledWith('appData', appData)
      expect(setup.setPath).toHaveBeenCalledWith('home', join(root, 'home'))
      expect(setup.setPath).toHaveBeenCalledTimes(2)
      for (const order of setup.setPath.mock.invocationCallOrder) {
        expect(order).toBeLessThan(setup.requestSingleInstanceLock.mock.invocationCallOrder[0] as number)
      }
      expect(setup.requestSingleInstanceLock).toHaveBeenCalledWith({ type: 'deepseek-harness:installer-close' })
      expect(setup.exit).toHaveBeenCalledWith(0)
      assertNormalCompositionUnused(setup)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('exits zero and releases a newly acquired lock without composing normal runtime state', async () => {
    const setup = prepareEntry(['--installer-request-close'], '')

    await import('../src/main.ts')

    expect(setup.requestSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(setup.requestSingleInstanceLock).toHaveBeenCalledWith({ type: 'deepseek-harness:installer-close' })
    expect(setup.releaseSingleInstanceLock).toHaveBeenCalledTimes(1)
    expect(setup.exit).toHaveBeenCalledWith(0)
    assertNormalCompositionUnused(setup)
  })

  it('exits zero immediately when Electron forwards the exact close intent to the existing instance', async () => {
    const setup = prepareEntry(['--installer-request-close'], '')
    setup.requestSingleInstanceLock.mockReturnValue(false)

    await import('../src/main.ts')

    expect(setup.releaseSingleInstanceLock).not.toHaveBeenCalled()
    expect(setup.exit).toHaveBeenCalledWith(0)
    assertNormalCompositionUnused(setup)
  })

  it.each([
    ['--installer-request-close=1'],
    ['--installer-request-close', '--unexpected'],
    ['--installer-request-close', '--installer-request-close'],
  ])('fails closed for malformed close-prefixed argv %j', async (...argv) => {
    const setup = prepareEntry(argv, '')
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await import('../src/main.ts')

    expect(setup.requestSingleInstanceLock).not.toHaveBeenCalled()
    expect(setup.exit).toHaveBeenCalledWith(1)
    assertNormalCompositionUnused(setup)
  })
})

describe('desktop Main background-presence composition', () => {
  it.skipIf(process.platform !== 'win32')('enables only the signed packaged update source and disables implicit installation', async () => {
    const setup = prepareNormalEntry()
    writeFileSync(join(setup.resourcesPath, 'app-update.yml'), [
      'provider: github',
      'owner: devin2255',
      'repo: deepseek-harness-desktop',
      "updaterCacheDirName: '@deepseek-aidsh-desktop-updater'",
      'publisherName:',
      '  - DeepSeek Harness Publisher',
      '',
    ].join('\n'))
    const updater = {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      disableWebInstaller: false,
      disableDifferentialDownload: false,
      allowDowngrade: true,
      checkForUpdates: vi.fn(async () => null),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
    }
    setup.desktopRequire.mockReturnValue({ autoUpdater: updater })

    await import('../src/main.ts')

    expect(setup.desktopRequire).toHaveBeenCalledWith('electron-updater')
    expect(updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      disableWebInstaller: true,
      disableDifferentialDownload: true,
      allowDowngrade: false,
    })
    const dependencies = setup.startDesktopMain.mock.calls[0]?.[0]
    if (dependencies === undefined) throw new Error('Expected desktop lifecycle dependencies')
    dependencies.createBackgroundPresence(new URL('http://127.0.0.1:4312'), 'capability', {
      openSession: async () => {}, requestQuit: () => {}, reportFailure: () => {},
    })
    expect(setup.createBackgroundPresence.mock.calls[0]?.[0].updates).toBeDefined()
  })

  it('wires the authenticated observer, native tray adapters, and conservative unavailable quit copy', async () => {
    const setup = prepareNormalEntry()

    await import('../src/main.ts')

    expect(setup.startDesktopMain).toHaveBeenCalledOnce()
    const dependencies = setup.startDesktopMain.mock.calls[0]?.[0]
    if (dependencies === undefined) throw new Error('Expected desktop lifecycle dependencies')
    const actions = {
      openSession: vi.fn(async () => {}),
      requestQuit: vi.fn(),
      reportFailure: vi.fn(),
    }
    dependencies.createBackgroundPresence(new URL('http://127.0.0.1:4312'), 'capability', actions)
    const options = setup.createBackgroundPresence.mock.calls[0]?.[0]
    if (options === undefined) throw new Error('Expected background-presence options')
    expect(options.actions).toBe(actions)
    expect(options.assets.windowsIconPath).toMatch(/tray\.ico$/u)
    expect(options.assets.macTemplateIconPath).toMatch(/trayTemplate\.png$/u)
    options.native.createTray('tray.ico')
    options.native.createNotification({ title: 'Done', body: 'Ready' })
    const menu = options.native.buildMenu([{ label: 'Open', enabled: true }])
    expect(setup.Tray).toHaveBeenCalledWith('tray.ico')
    expect(setup.Notification).toHaveBeenCalledWith({ title: 'Done', body: 'Ready' })
    expect(setup.buildFromTemplate).toHaveBeenCalledWith([{ label: 'Open', enabled: true }])
    expect(menu).toEqual([{ label: 'Open', enabled: true }])
    const callbacks = { onState: vi.fn(), reportError: vi.fn() }
    options.createObserver(callbacks)
    expect(setup.createTaskObserver).toHaveBeenCalledWith(expect.objectContaining({
      endpoint: new URL('http://127.0.0.1:4312'),
      capability: 'capability',
      pollIntervalMs: 2_000,
      requestTimeoutMs: 10_000,
      ...callbacks,
    }))

    setup.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(dependencies.confirmQuit({
      activeTaskCount: 9,
      activeAgentCount: 12,
      attentionCount: 1,
      notifications: [],
      freshness: 'unavailable',
    })).resolves.toBe('continue-background')
    const unavailableDialog = setup.showMessageBox.mock.calls[0]?.[0]
    expect(unavailableDialog?.buttons).toEqual(['Continue in Background', 'Stop and Quit', 'Cancel'])
    expect(unavailableDialog?.cancelId).toBe(2)
    expect(unavailableDialog?.defaultId).toBe(0)
    expect(unavailableDialog?.detail).toContain('cannot be confirmed')
    expect(unavailableDialog?.detail).not.toContain('9')

    setup.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(dependencies.confirmQuit({
      activeTaskCount: 1,
      activeAgentCount: 1,
      attentionCount: 0,
      notifications: [],
      freshness: 'live',
    })).resolves.toBe('stop-and-quit')
    expect(setup.showMessageBox.mock.calls[1]?.[0].detail).toContain('1 task still running')

    setup.getLocale.mockReturnValue('zh-CN')
    setup.showMessageBox.mockResolvedValueOnce({ response: 2 })
    await expect(dependencies.confirmQuit({
      activeTaskCount: 2,
      activeAgentCount: 2,
      attentionCount: 0,
      notifications: [],
      freshness: 'live',
    })).resolves.toBe('cancel')
    const chineseDialog = setup.showMessageBox.mock.calls[2]?.[0]
    expect(chineseDialog?.buttons).toEqual(['继续后台运行', '停止并退出', '取消'])
    expect(chineseDialog?.detail).toContain('2 个任务')

    setup.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(dependencies.confirmUpdateInstall({
      activeTaskCount: 2, activeAgentCount: 2, attentionCount: 0, notifications: [], freshness: 'live',
    })).resolves.toBe(false)
    const updateDialog = setup.showMessageBox.mock.calls[3]?.[0]
    expect(updateDialog?.buttons).toEqual(['稍后', '停止任务并安装'])
    expect(updateDialog?.defaultId).toBe(0)
    expect(updateDialog?.detail).toContain('2 个任务')

    setup.getLocale.mockReturnValue('en-US')
    setup.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(dependencies.confirmUpdateInstall({
      activeTaskCount: 0, activeAgentCount: 0, attentionCount: 0, notifications: [], freshness: 'unavailable',
    })).resolves.toBe(true)
    expect(setup.showMessageBox.mock.calls[4]?.[0].detail).toContain('cannot be confirmed')
  })
})

function prepareNormalEntry(): {
  readonly buildFromTemplate: Mock<(template: readonly unknown[]) => unknown>
  readonly createBackgroundPresence: Mock<(options: BackgroundPresenceOptions) => BackgroundPresence>
  readonly createTaskObserver: Mock<(options: TaskObserverOptions) => TaskObserver>
  readonly getLocale: Mock<() => string>
  readonly Notification: ReturnType<typeof vi.fn>
  readonly showMessageBox: Mock<(options: MessageBoxOptions) => Promise<{ readonly response: number }>>
  readonly startDesktopMain: Mock<(dependencies: DesktopMainDependencies) => DesktopMainHandle>
  readonly Tray: ReturnType<typeof vi.fn>
  readonly desktopRequire: Mock<(...args: unknown[]) => unknown>
  readonly resourcesPath: string
} {
  const appData = mkdtempSync(join(tmpdir(), 'dsh-main-normal-'))
  const resourcesPath = mkdtempSync(join(tmpdir(), 'dsh-main-normal-resources-'))
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
  process.argv = ['DeepSeek Harness.exe']
  process.env.APPDATA = appData
  const showMessageBox = vi.fn<(options: MessageBoxOptions) => Promise<{ readonly response: number }>>()
  const startDesktopMain = vi.fn<(dependencies: DesktopMainDependencies) => DesktopMainHandle>(() => ({
    ownsInstance: true, startup: Promise.resolve(), shutdown: Promise.resolve(), requestUpdateInstallation: async () => false,
  }))
  const initialState: TaskObserverState = Object.freeze({
    activeTaskCount: 0,
    activeAgentCount: 0,
    attentionCount: 0,
    notifications: Object.freeze([]),
    freshness: 'unavailable',
  })
  const createBackgroundPresence = vi.fn<(options: BackgroundPresenceOptions) => BackgroundPresence>(() => ({
    currentState: () => initialState,
    dispose: vi.fn(async () => {}),
  }))
  const createTaskObserver = vi.fn<(options: TaskObserverOptions) => TaskObserver>(() => ({ dispose: vi.fn(async () => {}) }))
  const buildFromTemplate = vi.fn<(template: readonly unknown[]) => unknown>(template => template)
  const Tray = vi.fn(function Tray() {})
  const Notification = vi.fn(function Notification() {})
  const desktopLog = { append: vi.fn(), currentPath: vi.fn(() => join(appData, 'desktop.log')) }
  const desktopRequire = Object.assign(vi.fn<(...args: unknown[]) => unknown>(), { resolve: vi.fn(() => 'cli-entry') })
  const getLocale = vi.fn(() => 'en-US')
  const app = {
    isPackaged: true,
    getLocale,
    whenReady: vi.fn(async () => {}),
  }
  vi.doMock('electron', () => ({
    app,
    dialog: { showMessageBox },
    Menu: { buildFromTemplate },
    Notification,
    shell: { openPath: vi.fn() },
    Tray,
  }))
  vi.doMock('node:module', () => ({ createRequire: vi.fn(() => desktopRequire) }))
  vi.doMock('../src/runtime-context.ts', () => ({
    resolveRuntimeContext: vi.fn(() => ({
      cliEntry: 'cli-entry',
      cwd: appData,
      environment: {},
      logs: appData,
    })),
  }))
  vi.doMock('../src/desktop-log.ts', () => ({
    DesktopLog: vi.fn(function DesktopLog() { return desktopLog }),
  }))
  vi.doMock('../src/main-lifecycle.ts', () => ({ startDesktopMain }))
  vi.doMock('../src/background-presence.ts', () => ({ createBackgroundPresence }))
  vi.doMock('../src/task-observer.ts', () => ({ createTaskObserver }))
  vi.doMock('../src/harness-supervisor.ts', () => ({ startHarness: vi.fn() }))
  vi.doMock('../src/startup-window.ts', () => ({ createStartupWindow: vi.fn() }))
  vi.doMock('../src/window.ts', () => ({ createDesktopWindow: vi.fn() }))
  return {
    buildFromTemplate,
    createBackgroundPresence,
    createTaskObserver,
    getLocale,
    Notification,
    showMessageBox,
    startDesktopMain,
    Tray,
    desktopRequire,
    resourcesPath,
  }
}

function prepareEntry(argv: readonly string[], environmentToken: string): {
  readonly appData: string
  readonly createRequire: ReturnType<typeof vi.fn>
  readonly createStartupWindow: ReturnType<typeof vi.fn>
  readonly createWindow: ReturnType<typeof vi.fn>
  readonly exit: ReturnType<typeof vi.fn>
  readonly releaseSingleInstanceLock: ReturnType<typeof vi.fn>
  readonly requestSingleInstanceLock: ReturnType<typeof vi.fn>
  readonly resolveRuntimeContext: ReturnType<typeof vi.fn>
  readonly startDesktopMain: ReturnType<typeof vi.fn>
  readonly startHarness: ReturnType<typeof vi.fn>
  readonly setPath: ReturnType<typeof vi.fn>
} {
  const appData = mkdtempSync(join(tmpdir(), 'dsh-main-cleanup-'))
  const resourcesPath = mkdtempSync(join(tmpdir(), 'dsh-main-resources-'))
  mkdirSync(join(resourcesPath, 'app', 'node_modules'), { recursive: true })
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: resourcesPath })
  const exit = vi.fn()
  const setPath = vi.fn()
  const releaseSingleInstanceLock = vi.fn()
  const requestSingleInstanceLock = vi.fn(() => true)
  const createRequire = vi.fn(() => { throw new Error('normal createRequire must remain lazy') })
  const resolveRuntimeContext = vi.fn(() => { throw new Error('normal runtime context must remain lazy') })
  const startDesktopMain = vi.fn()
  const startHarness = vi.fn()
  const createStartupWindow = vi.fn()
  const createWindow = vi.fn()
  process.argv = ['DeepSeek Harness.exe', ...argv]
  process.env.APPDATA = appData
  process.env[UNINSTALL_CLEANUP_ENVIRONMENT_KEY] = environmentToken
  vi.doMock('electron', () => ({
    app: { exit, isPackaged: true, releaseSingleInstanceLock, requestSingleInstanceLock, setPath, getPath: () => appData },
    shell: { openPath: vi.fn() },
  }))
  vi.doMock('node:module', () => ({ createRequire }))
  vi.doMock('../src/runtime-context.ts', () => ({ resolveRuntimeContext }))
  vi.doMock('../src/main-lifecycle.ts', () => ({ startDesktopMain }))
  vi.doMock('../src/harness-supervisor.ts', () => ({ startHarness }))
  vi.doMock('../src/startup-window.ts', () => ({ createStartupWindow }))
  vi.doMock('../src/window.ts', () => ({ createDesktopWindow: createWindow }))
  return {
    appData, createRequire, createStartupWindow, createWindow, exit, releaseSingleInstanceLock,
    requestSingleInstanceLock, resolveRuntimeContext, startDesktopMain, startHarness, setPath,
  }
}

function assertNormalCompositionUnused(setup: ReturnType<typeof prepareEntry>): void {
  expect(setup.createRequire).not.toHaveBeenCalled()
  expect(setup.resolveRuntimeContext).not.toHaveBeenCalled()
  expect(setup.startDesktopMain).not.toHaveBeenCalled()
  expect(setup.startHarness).not.toHaveBeenCalled()
  expect(setup.createStartupWindow).not.toHaveBeenCalled()
  expect(setup.createWindow).not.toHaveBeenCalled()
}

function setEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key)
  else process.env[key] = value
}
