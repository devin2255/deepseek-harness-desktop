import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
