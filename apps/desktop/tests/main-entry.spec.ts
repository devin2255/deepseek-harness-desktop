import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNINSTALL_CLEANUP_ENVIRONMENT_KEY } from '../src/uninstall-cleanup.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'
const originalArgv = process.argv
const originalAppData = process.env.APPDATA
const originalToken = process.env[UNINSTALL_CLEANUP_ENVIRONMENT_KEY]

afterEach(() => {
  process.argv = originalArgv
  setEnvironment('APPDATA', originalAppData)
  setEnvironment(UNINSTALL_CLEANUP_ENVIRONMENT_KEY, originalToken)
  vi.restoreAllMocks()
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

function prepareEntry(argv: readonly string[], environmentToken: string): {
  readonly appData: string
  readonly createRequire: ReturnType<typeof vi.fn>
  readonly createStartupWindow: ReturnType<typeof vi.fn>
  readonly createWindow: ReturnType<typeof vi.fn>
  readonly exit: ReturnType<typeof vi.fn>
  readonly resolveRuntimeContext: ReturnType<typeof vi.fn>
  readonly startDesktopMain: ReturnType<typeof vi.fn>
  readonly startHarness: ReturnType<typeof vi.fn>
} {
  const appData = mkdtempSync(join(tmpdir(), 'dsh-main-cleanup-'))
  const exit = vi.fn()
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
    app: { exit, isPackaged: true },
    shell: { openPath: vi.fn() },
  }))
  vi.doMock('node:module', () => ({ createRequire }))
  vi.doMock('../src/runtime-context.ts', () => ({ resolveRuntimeContext }))
  vi.doMock('../src/main-lifecycle.ts', () => ({ startDesktopMain }))
  vi.doMock('../src/harness-supervisor.ts', () => ({ startHarness }))
  vi.doMock('../src/startup-window.ts', () => ({ createStartupWindow }))
  vi.doMock('../src/window.ts', () => ({ createDesktopWindow: createWindow }))
  return { appData, createRequire, createStartupWindow, createWindow, exit, resolveRuntimeContext, startDesktopMain, startHarness }
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
