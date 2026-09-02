import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { access, lstat, mkdir, readFile, readlink, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, join, resolve, win32 } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron as electron, type ElectronApplication, type Page, type Request } from 'playwright'
import {
  INSTALLER_E2E_APP_DATA_MARKER,
  INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY,
  INSTALLER_E2E_ROOT_ENVIRONMENT_KEY,
} from '../src/installer-e2e-app-data.ts'

const execFileAsync = promisify(execFile)
const SENSITIVE_KEY = /KEY|SECRET|TOKEN|PASSWORD/iu
const BUILD_PATH = /(?:node_modules|\.pnpm|pnpm-store|deepseek-harness-desktop)/iu
const PRODUCT_KEY = 'HKCU\\Software\\5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478'
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478'
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const INSTALL_OPERATION_TIMEOUT_MS = 600_000
const UNINSTALL_OPERATION_TIMEOUT_MS = 300_000
const UNINSTALL_RESULT_FILE = 'dsh-uninstaller-e2e-result.txt'
const fixtureRuntimePackageRoots = new WeakMap<InstallerFixture, string[]>()

export interface InstallerFixture {
  readonly root: string
  readonly ownership: string
  readonly install: string
  readonly customInstall: string
  readonly appData: string
  readonly localAppData: string
  readonly home: string
  readonly productData: string
  readonly desktopShortcut: string
  readonly startMenuShortcut: string
  readonly runValue: string
  readonly environment: Record<string, string>
}

export interface IntegrationPaths {
  readonly desktop: string
  readonly startMenu: string
  readonly runValue: string
}

export interface RegistryState {
  readonly DshInstallerE2eRoot?: string
  readonly InstallLocation?: string
  readonly UninstallString?: string
}

export interface InstallerOptions {
  readonly install: string
  readonly desktop: 0 | 1
  readonly startMenu: 0 | 1
  readonly autostart: 0 | 1
  readonly launch: 0 | 1
  readonly defaultDestination?: boolean
  readonly gated?: boolean
}

/** Construct isolated paths and a scrubbed environment for one installer lifecycle. */
export async function createInstallerFixture(root: string): Promise<InstallerFixture> {
  const ownership = randomBytes(32).toString('base64url')
  const install = join(root, `default-${basename(root)}`)
  const customInstall = join(root, `custom-${basename(root)}`)
  const appData = join(root, 'appdata', 'roaming')
  const localAppData = join(root, 'appdata', 'local')
  const home = join(root, 'home')
  const temp = join(root, 'temp')
  await Promise.all([appData, localAppData, home, temp].map(path => mkdir(path, { recursive: true })))
  await writeFile(join(root, INSTALLER_E2E_APP_DATA_MARKER), `${ownership}\n`)
  const environment = Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => {
    if (value === undefined || SENSITIVE_KEY.test(key)) return []
    if (BUILD_PATH.test(value)) return []
    if (key.toUpperCase() === 'PATH') {
      const systemOnly = value.split(delimiter).filter(entry => !BUILD_PATH.test(entry)).join(delimiter)
      return systemOnly === '' ? [] : [[key, systemOnly]]
    }
    return [[key, value]]
  }))
  Object.assign(environment, {
    APPDATA: appData,
    DSH_INSTALLER_E2E: '1',
    [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: ownership,
    [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
    DSH_HOME: join(home, '.dsh'),
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
  })
  const integration = `DeepSeek Harness E2E - ${install.slice(install.lastIndexOf('\\') + 1)}`
  const folders = await shellFolders()
  return {
    root,
    ownership,
    install,
    customInstall,
    appData,
    localAppData,
    home,
    productData: join(appData, 'DeepSeek Harness'),
    desktopShortcut: join(folders.desktop, `${integration}.lnk`),
    startMenuShortcut: join(folders.programs, integration, `${integration}.lnk`),
    runValue: integration,
    environment,
  }
}

/** Resolve the unique integration names derived by E2E mode from an install leaf. */
export async function integrationPaths(installRoot: string, _environment: Record<string, string>): Promise<IntegrationPaths> {
  const leaf = installRoot.slice(Math.max(installRoot.lastIndexOf('\\'), installRoot.lastIndexOf('/')) + 1)
  const name = `DeepSeek Harness E2E - ${leaf}`
  const folders = await shellFolders()
  return {
    desktop: join(folders.desktop, `${name}.lnk`),
    startMenu: join(folders.programs, name, `${name}.lnk`),
    runValue: name,
  }
}

/** Refuse to start if any stable production identity is already present. */
export async function assertNoProductCollision(fixture: InstallerFixture): Promise<void> {
  for (const key of [PRODUCT_KEY, UNINSTALL_KEY]) {
    if (await registryKeyExists(key, fixture.environment)) throw new Error(`installer E2E collision: ${key}`)
  }
  for (const path of [fixture.install, fixture.customInstall, fixture.desktopShortcut, fixture.startMenuShortcut]) {
    if (await pathExists(path)) throw new Error(`installer E2E collision: ${path}`)
  }
  const production = await productionIntegrationPaths(fixture.environment)
  for (const path of production) {
    if (await pathExists(path)) throw new Error(`installer E2E collision: ${path}`)
  }
  if ((await registryValue(RUN_KEY, 'DeepSeek Harness', fixture.environment)) !== undefined) {
    throw new Error('installer E2E collision: production login startup exists')
  }
}

/** Run the assisted setup through deterministic test-only switches. */
export async function install(setup: string, fixture: InstallerFixture, options: InstallerOptions): Promise<number> {
  const startedAt = Date.now()
  const args = [
    '/S',
    ...(options.gated === false ? [] : ['/DSH_E2E=1']),
    `/DESKTOPSHORTCUT=${options.desktop}`,
    `/STARTMENUSHORTCUT=${options.startMenu}`,
    `/AUTOSTART=${options.autostart}`,
    `/LAUNCH=${options.launch}`,
  ]
  const environment = { ...fixture.environment }
  if (options.defaultDestination === true) environment.DSH_INSTALLER_E2E_DEFAULT_INSTALL = options.install
  else args.push(`/D=${options.install}`)
  const tracePath = join(environment.TEMP ?? fixture.root, 'dsh-installer-e2e.log')
  await unlink(tracePath).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  })
  const launcherExit = await runExecutable(setup, args, environment, INSTALL_OPERATION_TIMEOUT_MS)
  await waitForProcessState(setup, 'stopped', remainingOperationTime(startedAt, INSTALL_OPERATION_TIMEOUT_MS, 'installer'))
  const trace = await readFile(tracePath, 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  })
  const installed = hasInstallerCompletion(
    await pathExists(join(options.install, 'DeepSeek Harness.exe')),
    await pathExists(join(options.install, 'Uninstall DeepSeek Harness.exe')),
    trace,
  )
  if (!installed && options.gated !== false) {
    throw new Error(`gated installer did not complete (launcher exit ${launcherExit}): ${trace.trim()}`)
  }
  return installed ? 0 : launcherExit
}

/**
 * Require installed artifacts and a completion event from the fresh per-run trace.
 * @param executablePresent - Whether the installed application exists.
 * @param uninstallerPresent - Whether its uninstaller exists.
 * @param trace - Trace cleared before launching this setup invocation.
 * @returns Whether this invocation reached the completed install hook.
 */
export function hasInstallerCompletion(executablePresent: boolean, uninstallerPresent: boolean, trace: string): boolean {
  return executablePresent && uninstallerPresent && trace.split(/\r?\n/u).includes('custom install complete')
}

/** Run the installed uninstaller with a deterministic preserve/delete choice. */
export async function uninstall(fixture: InstallerFixture, installRoot: string, deleteUserData: 0 | 1): Promise<number> {
  await assertFixtureIdentity(fixture)
  const state = await registryState(UNINSTALL_KEY, fixture.environment)
  if (!isFixtureRegistryState(state, [installRoot])) throw new Error('refusing to run an unowned uninstaller')
  const startedAt = Date.now()
  const executable = join(installRoot, 'DeepSeek Harness.exe')
  const uninstaller = join(installRoot, 'Uninstall DeepSeek Harness.exe')
  const resultPath = join(fixture.environment.TEMP ?? fixture.root, UNINSTALL_RESULT_FILE)
  await unlink(resultPath).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  })
  const launcherExit = await runExecutable(uninstaller, [
    '/S', '/DSH_E2E=1', `/DELETEUSERDATA=${deleteUserData}`,
  ], fixture.environment, UNINSTALL_OPERATION_TIMEOUT_MS)
  await waitForProcessState(uninstaller, 'stopped', remainingOperationTime(startedAt, UNINSTALL_OPERATION_TIMEOUT_MS, 'uninstaller'))
  const result = await waitForUninstallResult(resultPath, remainingOperationTime(startedAt, UNINSTALL_OPERATION_TIMEOUT_MS, 'uninstaller'))
  if (result === 'cleanup-rejected') return 2
  if (launcherExit !== 0) throw new Error(`uninstaller launcher exited ${launcherExit} after accepting cleanup`)
  await waitUntil(async () => !(await pathExists(executable))
    && !(await pathExists(uninstaller))
    && !(await registryKeyExists(PRODUCT_KEY, fixture.environment))
    && !(await registryKeyExists(UNINSTALL_KEY, fixture.environment)),
  remainingOperationTime(startedAt, UNINSTALL_OPERATION_TIMEOUT_MS, 'uninstaller'))
  return 0
}

/**
 * Require isolated packaged readiness and shutdown through the close helper or an actual replacement.
 * @param fixture - Owned installer test data and launch environment.
 * @param installRoot - Exact installed application directory.
 * @param replaceRunningApplication - Optional installer operation that must close the ready application itself.
 */
export async function verifyInstalledApplication(
  fixture: InstallerFixture,
  installRoot: string,
  replaceRunningApplication?: () => Promise<void>,
): Promise<void> {
  await registerFixtureRuntimePackageRoot(fixture, join(installRoot, 'resources', 'app', 'node_modules'))
  let application: ElectronApplication | undefined
  let applicationClosed = false
  try {
    const startedAt = Date.now()
    application = await electron.launch({
      executablePath: join(installRoot, 'DeepSeek Harness.exe'),
      args: [
        `--dsh-installer-e2e-root=${fixture.root}`,
        `--dsh-installer-e2e-ownership=${fixture.ownership}`,
      ],
      env: fixture.environment,
      timeout: 5_000,
    })
    application.once('close', () => { applicationClosed = true })
    const startup = await application.firstWindow({ timeout: 5_000 })
    const profile = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), home: app.getPath('home'), name: app.getName() }))
    if (resolve(profile.userData) !== resolve(fixture.appData, profile.name)) throw new Error('installed Electron profile did not use test APPDATA')
    if (resolve(profile.home) !== resolve(fixture.home)) throw new Error('installed Harness working directory did not use the test home')
    if (Date.now() - startedAt > 5_000) throw new Error('installed startup window exceeded five seconds')
    const main = await waitForMainWindow(application, startup)
    await main.waitForLoadState('load', { timeout: 10_000 })
    const authorization = captureAuthorization(main)
    const result = await main.evaluate(async () => {
      const controller = new AbortController()
      const timer = setTimeout(() =>{  controller.abort() }, 10_000)
      try {
        const response = await fetch('/api/host.describe', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal,
        })
        return { body: await response.json() as unknown, status: response.status, title: document.title }
      } finally {
        clearTimeout(timer)
      }
    })
    if (result.status !== 200 || result.title !== 'DeepSeek Harness') {
      throw new Error(`installed readiness failed: ${JSON.stringify(result)}`)
    }
    if (result.body === null || typeof result.body !== 'object' || !Object.hasOwn(result.body, 'result')) {
      throw new Error('installed readiness returned an invalid host description')
    }
    const bearer = await authorization
    if (!/^Bearer [A-Za-z0-9_-]{43}$/u.test(bearer)) throw new Error('installed readiness used invalid authorization')
    if (!await pathExists(fixture.productData)) throw new Error('installed runtime did not use test APPDATA')
    if (replaceRunningApplication === undefined) await verifyLaunchAndClose(fixture, installRoot)
    else {
      await replaceRunningApplication()
      await waitForProcessState(join(installRoot, 'DeepSeek Harness.exe'), 'stopped')
    }
  } catch (error: unknown) {
    const diagnostics = await readFile(join(fixture.productData, 'logs', 'desktop.log'), 'utf8')
      .then(log => log.slice(-16_384), () => '<desktop log unavailable>')
    throw new Error(`installed application readiness failed; isolated desktop log:\n${diagnostics}`, { cause: error })
  } finally {
    if (application !== undefined && !applicationClosed) await boundedClose(application)
  }
  await waitForProcessState(join(installRoot, 'DeepSeek Harness.exe'), 'stopped')
}

function captureAuthorization(page: Page): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      page.off('request', onRequest)
      reject(new Error('installed authorization header was not observed'))
    }, 10_000)
    const onRequest = (request: Request): void => {
      if (!request.url().endsWith('/api/host.describe')) return
      void request.allHeaders().then((headers) => {
        clearTimeout(timer)
        page.off('request', onRequest)
        const value = headers.authorization
        if (value === undefined) reject(new Error('installed authorization header was absent'))
        else resolve(value)
      }, reject)
    }
    page.on('request', onRequest)
  })
}

/** Wait for the LAUNCH option and request the owned application to close cleanly. */
export async function verifyLaunchAndClose(fixture: InstallerFixture, installRoot: string): Promise<void> {
  const executable = join(installRoot, 'DeepSeek Harness.exe')
  await waitForProcessState(executable, 'running')
  const exit = await runExecutable(executable, [
    '--installer-request-close',
    `--dsh-installer-e2e-root=${fixture.root}`,
    `--dsh-installer-e2e-ownership=${fixture.ownership}`,
  ], fixture.environment, 20_000)
  if (exit !== 0) throw new Error(`installer close request exited ${exit}`)
  await waitForProcessState(executable, 'stopped')
}

/** Read one registry value without changing Windows state. */
export async function readRegistryValue(key: string, name: string, environment: Record<string, string>): Promise<string | undefined> {
  return registryValue(key, name, environment)
}

/** Write the installed-version value only after proving the registered installation belongs to this fixture. */
export async function setInstalledVersion(fixture: InstallerFixture, version: string): Promise<void> {
  const state = await registryState(UNINSTALL_KEY, fixture.environment)
  if (!isFixtureRegistryState(state, [fixture.install, fixture.customInstall])) {
    throw new Error('refusing to change an unowned installer registry key')
  }
  const marker = state.DshInstallerE2eRoot ?? state.InstallLocation ?? fixture.install
  await execFileAsync('reg.exe', ['add', UNINSTALL_KEY, '/v', 'DshInstallerE2eRoot', '/t', 'REG_SZ', '/d', marker, '/f'], { env: fixture.environment })
  await execFileAsync('reg.exe', ['add', UNINSTALL_KEY, '/v', 'DisplayVersion', '/t', 'REG_SZ', '/d', version, '/f'], { env: fixture.environment })
}

/** Return whether an ordinary path currently exists. */
export async function exists(path: string): Promise<boolean> { return pathExists(path) }

/** Best-effort cleanup limited to collision-checked test-owned paths and exact owned registry values. */
export async function cleanupInstallerFixture(fixture: InstallerFixture): Promise<void> {
  await assertFixtureRootOwnership(fixture)
  for (const installRoot of [fixture.install, fixture.customInstall]) {
    if (await pathExists(join(installRoot, 'Uninstall DeepSeek Harness.exe'))) {
      await uninstall(fixture, installRoot, 0).catch(() => 1)
    }
  }
  await waitUntil(async () => !(await pathExists(join(fixture.install, 'DeepSeek Harness.exe')))
    && !(await pathExists(join(fixture.customInstall, 'DeepSeek Harness.exe'))), 20_000).catch(() => undefined)
  for (const [key, name] of [[RUN_KEY, fixture.runValue]] as const) {
    const value = await registryValue(key, name, fixture.environment)
    if (value !== undefined && [fixture.install, fixture.customInstall].some(root => value.includes(root))) {
      await execFileAsync('reg.exe', ['delete', key, '/v', name, '/f'], { env: fixture.environment }).catch(() => undefined)
    }
  }
  const roots = [fixture.install, fixture.customInstall]
  const ownershipErrors: string[] = []
  for (const key of [PRODUCT_KEY, UNINSTALL_KEY]) {
    const state = await registryState(key, fixture.environment)
    if (Object.keys(state).length === 0) continue
    if (!isFixtureRegistryState(state, roots)) {
      ownershipErrors.push(`refusing to delete unowned installer registry key: ${key}`)
      continue
    }
    await execFileAsync('reg.exe', ['delete', key, '/f'], { env: fixture.environment })
  }
  for (const path of [fixture.desktopShortcut, fixture.startMenuShortcut]) {
    if (await pathExists(path)) await unlink(path).catch(() => undefined)
  }
  await rm(dirname(fixture.startMenuShortcut), { recursive: false, force: true }).catch(() => undefined)
  await cleanupInstallerFixtureDirectory(fixture)
  if (ownershipErrors.length > 0) throw new Error(ownershipErrors.join('\n'))
}

/** Remove an authenticated fixture directory without invoking uninstallers or modifying Windows integrations. */
export async function cleanupInstallerFixtureDirectory(fixture: InstallerFixture): Promise<void> {
  await assertFixtureRootOwnership(fixture)
  await removeOwnedFallbackRedirects(fixture)
  await assertFixtureRootOwnership(fixture)
  await rm(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 })
}

async function assertFixtureRootOwnership(fixture: InstallerFixture): Promise<void> {
  await assertFixtureIdentity(fixture)
  await assertRedirectsOwned(fixture, fixture.root)
}

async function assertFixtureIdentity(fixture: InstallerFixture): Promise<void> {
  const resolvedRoot = win32.resolve(fixture.root)
  const physicalRoot = await realpath(fixture.root)
  const marker = join(fixture.root, INSTALLER_E2E_APP_DATA_MARKER)
  const markerStatus = await lstat(marker)
  const markerContent = await readFile(marker, 'utf8')
  if (
    physicalRoot.toLocaleLowerCase() !== resolvedRoot.toLocaleLowerCase()
    || !markerStatus.isFile()
    || markerStatus.isSymbolicLink()
    || !/^[A-Za-z0-9_-]{43}$/u.test(fixture.ownership)
    || fixture.environment[INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY] !== fixture.ownership
    || markerContent !== `${fixture.ownership}\n`
    || ![fixture.install, fixture.customInstall, fixture.appData, fixture.localAppData, fixture.home]
      .every(path => isPathInside(path, fixture.root))
  ) throw new Error('refusing to clean an unowned installer fixture root')
}

/** Register the ordinary runtime package directory that generated fallback links may target. */
export async function registerFixtureRuntimePackageRoot(fixture: InstallerFixture, packageRoot: string): Promise<void> {
  const resolved = win32.resolve(packageRoot)
  const physical = await realpath(packageRoot)
  const status = await lstat(packageRoot)
  if (
    physical.toLocaleLowerCase() !== resolved.toLocaleLowerCase()
    || !status.isDirectory()
    || status.isSymbolicLink()
  ) throw new Error('refusing an unsafe installer runtime package root')
  await assertOrdinaryAncestors(resolved)
  const roots = fixtureRuntimePackageRoots.get(fixture) ?? []
  if (!roots.some(root => root.toLocaleLowerCase() === resolved.toLocaleLowerCase())) roots.push(resolved)
  fixtureRuntimePackageRoots.set(fixture, roots)
}

async function assertOrdinaryAncestors(path: string): Promise<void> {
  const root = win32.parse(path).root
  let current = root
  for (const component of win32.relative(root, path).split('\\').filter(Boolean)) {
    current = join(current, component)
    const status = await lstat(current)
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new Error('refusing an unsafe installer runtime package root')
    }
  }
}

async function assertRedirectsOwned(fixture: InstallerFixture, root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const status = await lstat(path)
    if (status.isSymbolicLink()) {
      if (!await isOwnedFallbackRedirect(fixture, path)) {
        throw new Error('refusing to clean an unowned installer fixture root')
      }
      continue
    }
    if (status.isDirectory()) await assertRedirectsOwned(fixture, path)
  }
}

async function removeOwnedFallbackRedirects(fixture: InstallerFixture): Promise<void> {
  await removeOwnedRedirectsUnder(fixture, fixture.root)
}

async function removeOwnedRedirectsUnder(fixture: InstallerFixture, root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    const status = await lstat(path)
    if (status.isSymbolicLink()) {
      if (!await isOwnedFallbackRedirect(fixture, path)) {
        throw new Error('refusing to clean an unowned installer fixture root')
      }
      await unlink(path)
      continue
    }
    if (status.isDirectory()) await removeOwnedRedirectsUnder(fixture, path)
  }
}

async function isOwnedFallbackRedirect(fixture: InstallerFixture, path: string): Promise<boolean> {
  const fallbackRoot = join(fixture.productData, 'Harness', 'profiles', 'node_modules')
  if (!isPathInside(path, fallbackRoot) || win32.resolve(path) === win32.resolve(fallbackRoot)) return false
  const roots = fixtureRuntimePackageRoots.get(fixture) ?? []
  const linkedTarget = win32.resolve(dirname(path), await readlink(path))
  const registered = roots.filter(root => isPathInside(linkedTarget, root))
  if (registered.length === 0) return false
  try {
    const target = await realpath(path)
    return registered.some(root => isPathInside(target, root))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true
    throw error
  }
}

/** Return whether strong registry evidence identifies a test-owned install root. */
export function isFixtureRegistryState(state: RegistryState, roots: readonly string[]): boolean {
  const candidates = [state.InstallLocation, state.DshInstallerE2eRoot, parseExecutablePath(state.UninstallString)]
  return candidates.some(candidate => candidate !== undefined && roots.some(root => isPathInside(candidate, root)))
}

/** Replace the product-data directory with a junction to a test-owned target. */
export async function redirectProductData(productData: string, target: string): Promise<void> {
  await rm(productData, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await execFileAsync('cmd.exe', ['/d', '/c', 'mklink', '/J', productData, target])
}

/** Unlink a junction without traversing its target. */
export async function unlinkRedirect(path: string): Promise<void> {
  const status = await lstat(path)
  if (!status.isSymbolicLink()) throw new Error(`expected junction: ${path}`)
  await unlink(path)
}

async function waitForMainWindow(application: ElectronApplication, first: Awaited<ReturnType<ElectronApplication['firstWindow']>>) {
  const deadline = Date.now() + 75_000
  let page = first
  while (Date.now() < deadline) {
    const ready = application.windows().find(candidate => candidate.url().startsWith('http://127.0.0.1:'))
    if (ready !== undefined) {
      await ready.waitForFunction(() => document.title === 'DeepSeek Harness', undefined, { timeout: 5_000 })
      return ready
    }
    await new Promise(resolve => setTimeout(resolve, 100))
    page = application.windows().at(-1) ?? page
  }
  throw new Error(`main window did not become ready; last title: ${await page.title()}`)
}

async function boundedClose(application: ElectronApplication): Promise<void> {
  await Promise.race([
    application.close(),
    new Promise<never>((_resolve, reject) => setTimeout(() =>{  reject(new Error('installed application did not close within 15s')) }, 15_000)),
  ])
}

async function runExecutable(file: string, args: string[], environment: Record<string, string>, timeout: number): Promise<number> {
  try {
    await execFileAsync(file, args, { env: environment, timeout, windowsHide: true, maxBuffer: 64 * 1024 })
    return 0
  } catch (error: unknown) {
    if (error instanceof Error && 'killed' in error && error.killed === true) {
      throw new Error(`owned executable exceeded ${timeout}ms`, { cause: error })
    }
    if (error instanceof Error && 'code' in error && typeof error.code === 'number') return error.code
    throw error
  }
}

async function waitForUninstallResult(path: string, timeout: number): Promise<'cleanup-rejected' | 'uninstall-accepted'> {
  let result: string | undefined
  await waitUntil(async () => {
    result = await readFile(path, 'utf8').then(value => value.trim(), (error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
      throw error
    })
    return result !== undefined
  }, timeout)
  if (result !== 'cleanup-rejected' && result !== 'uninstall-accepted') {
    throw new Error('uninstaller returned an invalid E2E result')
  }
  return result
}

function remainingOperationTime(startedAt: number, timeout: number, operation: string): number {
  const remaining = timeout - (Date.now() - startedAt)
  if (remaining <= 0) throw new Error(`${operation} exceeded ${timeout}ms`)
  return remaining
}

async function registryKeyExists(key: string, environment: Record<string, string>): Promise<boolean> {
  try { await execFileAsync('reg.exe', ['query', key], { env: environment }); return true } catch { return false }
}

async function registryValue(key: string, name: string, environment: Record<string, string>): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', name], { env: environment })
    return stdout.match(/\s+REG_\w+\s+(?<value>.*)\r?$/mu)?.groups?.value?.trim()
  } catch { return undefined }
}

async function registryState(key: string, environment: Record<string, string>): Promise<RegistryState> {
  const [InstallLocation, UninstallString, DshInstallerE2eRoot] = await Promise.all([
    registryValue(key, 'InstallLocation', environment),
    registryValue(key, 'UninstallString', environment),
    registryValue(key, 'DshInstallerE2eRoot', environment),
  ])
  return Object.fromEntries(Object.entries({ InstallLocation, UninstallString, DshInstallerE2eRoot })
    .filter((entry): entry is [string, string] => entry[1] !== undefined))
}

function parseExecutablePath(command: string | undefined): string | undefined {
  if (command === undefined) return undefined
  const trimmed = command.trim()
  if (trimmed.startsWith('"')) {
    const closingQuote = trimmed.indexOf('"', 1)
    return closingQuote > 1 ? trimmed.slice(1, closingQuote) : undefined
  }
  return /^\S+\.exe$/iu.test(trimmed) ? trimmed : undefined
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = win32.relative(win32.resolve(root), win32.resolve(candidate))
  return relative === '' || (!relative.startsWith('..\\') && relative !== '..' && !win32.isAbsolute(relative))
}

async function shellFolders(): Promise<{ desktop: string; programs: string }> {
  const source = "[Console]::Out.Write(([Environment]::GetFolderPath('Desktop')) + [char]10 + ([Environment]::GetFolderPath('Programs')))"
  const command = Buffer.from(source, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], { env: process.env })
  const [desktop, programs] = stdout.split(/\r?\n/u)
  if (desktop === undefined || programs === undefined || desktop === '' || programs === '') throw new Error('Windows shell folders are unavailable')
  return { desktop, programs }
}

async function productionIntegrationPaths(environment: Record<string, string>): Promise<string[]> {
  void environment
  const folders = await shellFolders()
  return [join(folders.desktop, 'DeepSeek Harness.lnk'), join(folders.programs, 'DeepSeek Harness', 'DeepSeek Harness.lnk')]
}

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch { return false }
}

async function waitForProcessState(executable: string, expected: 'running' | 'stopped', timeout = 20_000): Promise<void> {
  const script = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../build/query-installed-process.ps1'), 'utf8')
  const command = Buffer.from(script.replace(/^\uFEFF/u, ''), 'utf16le').toString('base64')
  await waitUntil(async (remaining) => {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', command], {
      env: { ...process.env, DSH_INSTALLER_TARGET_EXE: executable },
      timeout: Math.min(remaining, 10_000),
    })
    return stdout.trim() === expected
  }, timeout)
}

async function waitUntil(predicate: (remaining: number) => Promise<boolean>, timeout: number): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate(deadline - Date.now())) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`condition did not settle within ${timeout}ms`)
}
