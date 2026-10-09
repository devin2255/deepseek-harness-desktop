/** Keyless built desktop journey; disk state and native windows are observed independently. */
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { afterEach, describe, expect, it } from 'vitest'
import type { SavedWindowState, WindowBounds } from '../src/window-state.ts'

const EXPECTED = fileURLToPath(new URL('./snapshots/window-state/result.expected.json', import.meta.url))
const ENTRY = fileURLToPath(new URL('../lib/main.js', import.meta.url))
let root: string | undefined
let application: ElectronApplication | undefined

afterEach(async () => {
  if (application !== undefined) await quit(application)
  application = undefined
  if (root !== undefined) { await rm(root, { recursive: true, force: true }); root = undefined }
})

describe('desktop window state snapshot', () => {
  it('restores normal bounds and maximization across native-window recreation and cold startup', async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-desktop-layout-'))
    const appData = join(root, 'appdata')
    const home = join(root, 'home')
    await Promise.all([appData, home].map(path => mkdir(path, { recursive: true })))
    const entry = join(root, 'entry.mjs')
    await writeFile(entry, [
      "import { app, dialog, Tray, utilityProcess } from 'electron'",
      `app.setPath('appData', ${JSON.stringify(appData)})`,
      `app.setPath('home', ${JSON.stringify(home)})`,
      'globalThis.__windowStateHarnessLaunches = 0',
      'const fork = utilityProcess.fork.bind(utilityProcess)',
      'utilityProcess.fork = (...args) => { globalThis.__windowStateHarnessLaunches++; return fork(...args) }',
      'const on = Tray.prototype.on',
      "Tray.prototype.on = function (event, listener) { if (event === 'click') globalThis.__windowStateTrayClick = listener; return on.call(this, event, listener) }",
      'dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })',
      `await import(${JSON.stringify(pathToFileURL(ENTRY).href)})`,
      '',
    ].join('\n'))
    const environment = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => (
      value === undefined || /KEY|SECRET|TOKEN|PASSWORD/iu.test(key) || key === 'ELECTRON_RUN_AS_NODE' ? [] : [[key, value]]
    )))
    const launch = async (): Promise<Page> => {
      application = await electron.launch({
        args: [entry, `--user-data-dir=${join(root!, 'electron-profile')}`], env: environment, timeout: 15_000,
      })
      let page: Page | undefined
      await expect.poll(() => {
        page = application?.windows().find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//u.test(candidate.url()))
        return page !== undefined
      }, { timeout: 75_000 }).toBe(true)
      if (page === undefined) throw new Error('Authorized desktop window did not open')
      await page.waitForLoadState('load')
      await expect.poll(() => page!.locator('#root').innerHTML(), { timeout: 15_000 }).not.toBe('')
      return page
    }
    const file = join(appData, 'DeepSeek Harness', 'window-state.json')
    const disk = async (): Promise<SavedWindowState> => JSON.parse(await readFile(file, 'utf8')) as SavedWindowState
    const trace: Record<string, unknown>[] = []
    let page = await launch()
    const bounds = await application!.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))
      if (window === undefined) throw new Error('Main desktop window is missing')
      const area = screen.getPrimaryDisplay().workArea
      const width = Math.min(1120, area.width)
      const height = Math.min(700, area.height)
      window.setBounds({
        x: area.x + Math.floor((area.width - width) / 3), y: area.y + Math.floor((area.height - height) / 3), width, height,
      })
      return window.getNormalBounds()
    })
    await expect.poll(async () => (await disk().catch(() => undefined))?.bounds, { timeout: 10_000 }).toEqual(bounds)
    trace.push({ step: 'move-and-resize', normalBoundsPersisted: true, version: (await disk()).version, maximized: (await disk()).maximized })

    await page.close()
    await expect.poll(() => application!.windows().length).toBe(0)
    await application!.evaluate(() => {
      const click = (globalThis as unknown as { __windowStateTrayClick?: () => void }).__windowStateTrayClick
      if (click === undefined) throw new Error('Native tray callback is missing')
      click()
    })
    page = await authorizedWindow(application!)
    expect(await nativeState(application!)).toEqual({ bounds, maximized: false, minimized: false, fullscreen: false })
    const launches = await application!.evaluate(() => (
      (globalThis as unknown as { __windowStateHarnessLaunches: number }).__windowStateHarnessLaunches
    ))
    expect(launches).toBe(1)
    trace.push({ step: 'reopen-window', normalBoundsRestored: true, harnessLaunches: launches })

    await application!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))
      if (window === undefined) throw new Error('Main desktop window is missing')
      window.maximize()
    })
    await expect.poll(async () => (await nativeState(application!)).maximized, { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => (await disk()).maximized, { timeout: 10_000 }).toBe(true)
    expect((await disk()).bounds).toEqual(bounds)
    trace.push({ step: 'maximize', maximizedPersisted: true, normalBoundsPreserved: true })
    await quit(application!)
    application = undefined
    page = await launch()
    await expect.poll(async () => (await nativeState(application!)).maximized, { timeout: 10_000 }).toBe(true)
    expect((await nativeState(application!)).bounds).toEqual(bounds)
    trace.push({ step: 'cold-start', maximizedRestored: true, normalBoundsRestored: true })

    await application!.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))
      if (window === undefined) throw new Error('Main desktop window is missing')
      window.unmaximize()
    })
    await expect.poll(async () => (await nativeState(application!)).maximized, { timeout: 10_000 }).toBe(false)
    expect((await nativeState(application!)).bounds).toEqual(bounds)
    await quit(application!)
    application = undefined
    expect((await disk()).maximized).toBe(false)
    trace.push({ step: 'unmaximize-and-quit', normalBoundsRestored: true, finalStatePublishedBeforeExit: true })

    await writeFile(file, JSON.stringify({ version: 1, bounds: { x: 999999, y: -999999, width: 4000, height: 4000 }, maximized: false }))
    page = await launch()
    const visible = await application!.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))
      if (window === undefined) throw new Error('Main desktop window is missing')
      const current = window.getNormalBounds()
      const area = screen.getPrimaryDisplay().workArea
      return current.x >= area.x && current.y >= area.y
        && current.x + current.width <= area.x + area.width && current.y + current.height <= area.y + area.height
    })
    expect(visible).toBe(true)
    trace.push({ step: 'removed-display', entireWindowVisibleOnPrimary: visible })
    await quit(application!)
    application = undefined
    await writeFile(file, '{invalid-json')
    page = await launch()
    expect((await nativeState(application!)).maximized).toBe(false)
    expect(await page.title()).toBe('DeepSeek Harness')
    const log = await readFile(join(appData, 'DeepSeek Harness', 'logs', 'desktop.log'), 'utf8')
    expect(log).toContain('desktop-window-state-failure')
    trace.push({ step: 'invalid-preference', applicationUsable: true, failureDiagnosed: true })

    const actual = `${JSON.stringify(trace, null, 2)}\n`
    if (process.env.DSH_SNAPSHOT === 'refresh') {
      await mkdir(fileURLToPath(new URL('./snapshots/window-state/', import.meta.url)), { recursive: true })
      await writeFile(EXPECTED, actual)
    } else {
      expect(actual).toBe(await readFile(EXPECTED, 'utf8'))
    }
  }, 300_000)
})

async function authorizedWindow(target: ElectronApplication): Promise<Page> {
  let page: Page | undefined
  await expect.poll(() => {
    page = target.windows().find(candidate => /^http:\/\/127\.0\.0\.1:\d+\//u.test(candidate.url()))
    return page !== undefined
  }, { timeout: 75_000 }).toBe(true)
  if (page === undefined) throw new Error('Authorized desktop window did not reopen')
  await page.waitForLoadState('load')
  return page
}

async function nativeState(target: ElectronApplication): Promise<{
  readonly bounds: WindowBounds
  readonly maximized: boolean
  readonly minimized: boolean
  readonly fullscreen: boolean
}> {
  return target.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().startsWith('http:'))
    if (window === undefined) throw new Error('Main desktop window is missing')
    return {
      bounds: window.getNormalBounds(), maximized: window.isMaximized(), minimized: window.isMinimized(), fullscreen: window.isFullScreen(),
    }
  })
}

async function quit(target: ElectronApplication): Promise<void> {
  const closed = target.waitForEvent('close', { timeout: 15_000 })
  await target.evaluate(({ app }) => { app.quit() })
  await closed
}
