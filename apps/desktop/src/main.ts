/** Electron entry binding cleanup mode or the normal retryable desktop lifecycle. */
import { app, dialog, Menu, Notification, shell, Tray } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquirePlatformApplicationMutex } from './application-mutex.ts'
import { createBackgroundPresence, type BackgroundMenuItem } from './background-presence.ts'
import { DesktopLog } from './desktop-log.ts'
import { startHarness } from './harness-supervisor.ts'
import { configureInstallerE2eAppData } from './installer-e2e-app-data.ts'
import { classifyInstallerCloseIntent } from './installer-close-intent.ts'
import { startDesktopMain, type DesktopQuitDecision } from './main-lifecycle.ts'
import { resolveRuntimeContext } from './runtime-context.ts'
import { createStartupWindow } from './startup-window.ts'
import { createTaskObserver, type TaskObserverState } from './task-observer.ts'
import {
  isUninstallCleanupInvocation,
  runUninstallCleanup,
} from './uninstall-cleanup.ts'
import { createDesktopWindow } from './window.ts'

const DESKTOP_CLEANUP_TIMEOUT_MS = 10_000
const UNINSTALL_CLEANUP_MAX_SNAPSHOT_ENTRIES = 100_000
const DESKTOP_LOG_MAX_BYTES = 1_048_576
const DESKTOP_LOG_MAX_MESSAGE_CODE_UNITS = 16_384
const DESKTOP_LOG_MAX_METADATA_CODE_UNITS = 128
const DESKTOP_TASK_POLL_INTERVAL_MS = 2_000
const DESKTOP_TASK_REQUEST_TIMEOUT_MS = 10_000
const desktopArguments = process.argv.slice(app.isPackaged ? 1 : 2)

if (isUninstallCleanupInvocation(desktopArguments)) {
  void runUninstallCleanup({
    argv: desktopArguments,
    environment: process.env,
    maxSnapshotEntries: UNINSTALL_CLEANUP_MAX_SNAPSHOT_ENTRIES,
    fallbackPackageRoots: [join(process.resourcesPath, 'app', 'node_modules')],
  }).then(
    () => { app.exit(0) },
    () => {
      console.error('DeepSeek Harness uninstall cleanup was rejected or failed.')
      app.exit(1)
    },
  )
} else {
  startDesktopInvocation()
}

/** Resolve validated test metadata before choosing the single-instance operation. */
function startDesktopInvocation(): void {
  const arguments_ = configureInstallerE2eAppData({ app, argv: desktopArguments, environment: process.env, platform: process.platform })
  const installerCloseIntent = classifyInstallerCloseIntent(arguments_)
  if (installerCloseIntent === 'none') {
    startNormalDesktop()
    return
  }
  if (installerCloseIntent === 'malformed') {
    console.error('DeepSeek Harness installer close request was rejected.')
    app.exit(1)
  } else {
    const ownsInstance = app.requestSingleInstanceLock({ type: 'deepseek-harness:installer-close' })
    if (ownsInstance) app.releaseSingleInstanceLock()
    app.exit(0)
  }
}

/** Compose normal desktop operations only after cleanup mode has been excluded. */
function startNormalDesktop(): void {
  const desktopRequire = createRequire(import.meta.url)
  const runtimeContext = resolveRuntimeContext(app, {
    resourcesPath: process.resourcesPath,
    environment: process.env,
    resolveDevelopmentCli: specifier => desktopRequire.resolve(specifier),
  })
  const desktopLog = new DesktopLog({
    directory: runtimeContext.logs,
    maxBytes: DESKTOP_LOG_MAX_BYTES,
    maxMessageCodeUnits: DESKTOP_LOG_MAX_MESSAGE_CODE_UNITS,
    maxMetadataCodeUnits: DESKTOP_LOG_MAX_METADATA_CODE_UNITS,
    sensitiveValues: sensitiveEnvironmentValues(process.env),
  })
  startDesktopMain({
    app,
    acquireApplicationMutex: () => acquirePlatformApplicationMutex(process.platform),
    launchSpec: runtimeContext,
    platform: process.platform,
    startHarness: (launchSpec, options) => startHarness(launchSpec, options),
    createStartupWindow: actions => createStartupWindow(actions),
    createWindow: (endpoint, capability) => createDesktopWindow(endpoint, capability),
    createBackgroundPresence: (endpoint, capability, actions) => createBackgroundPresence({
      actions,
      assets: {
        windowsIconPath: fileURLToPath(new URL('./tray.ico', import.meta.url)),
        macTemplateIconPath: fileURLToPath(new URL('./trayTemplate.png', import.meta.url)),
      },
      native: {
        locale: app.getLocale(),
        platform: process.platform,
        createTray: iconPath => new Tray(iconPath),
        buildMenu: template => Menu.buildFromTemplate(menuTemplate(template)),
        createNotification: options => new Notification(options),
      },
      createObserver: callbacks => createTaskObserver({
        endpoint,
        capability,
        fetch: globalThis.fetch,
        pollIntervalMs: DESKTOP_TASK_POLL_INTERVAL_MS,
        requestTimeoutMs: DESKTOP_TASK_REQUEST_TIMEOUT_MS,
        ...callbacks,
      }),
    }),
    confirmQuit: state => confirmDesktopQuit(state, app.getLocale()),
    desktopLog,
    openPath: path => shell.openPath(path),
    cleanupTimeoutMs: DESKTOP_CLEANUP_TIMEOUT_MS,
    now: () => new Date().toISOString(),
    reportFailure: (phase, error) => {
      desktopLog.append({
        timestamp: new Date().toISOString(),
        type: `desktop-${phase}-failure`,
        message: error instanceof Error ? error.stack ?? error.message : String(error),
      })
    },
  })
}

/** Convert the product menu projection into mutable Electron constructor records. */
function menuTemplate(template: readonly BackgroundMenuItem[]): Electron.MenuItemConstructorOptions[] {
  return template.map(item => ({ ...item }))
}

/** Present conservative native quit copy and map the selected button to lifecycle intent. */
async function confirmDesktopQuit(state: TaskObserverState, locale: string): Promise<DesktopQuitDecision> {
  const chinese = /^zh(?:-|$)/iu.test(locale)
  const detail = state.freshness === 'live'
    ? chinese
      ? `当前有 ${state.activeTaskCount} 个任务仍在运行。停止并退出会终止这些任务。`
      : `${state.activeTaskCount} task${state.activeTaskCount === 1 ? '' : 's'} still running. Stopping and quitting will terminate them.`
    : chinese
      ? '目前无法确认任务活动状态。为避免意外中断，建议继续在后台运行。'
      : 'Current task activity cannot be confirmed. Continue in the background to avoid an unintended interruption.'
  const buttons = chinese
    ? ['继续后台运行', '停止并退出', '取消']
    : ['Continue in Background', 'Stop and Quit', 'Cancel']
  const result = await dialog.showMessageBox({
    type: 'warning',
    title: chinese ? '退出 DeepSeek Harness？' : 'Quit DeepSeek Harness?',
    message: chinese ? 'DeepSeek Harness 可能仍在执行任务' : 'DeepSeek Harness may still be running tasks',
    detail,
    buttons,
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  return result.response === 0
    ? 'continue-background'
    : result.response === 1
      ? 'stop-and-quit'
      : 'cancel'
}

/** Select inherited secret values that the mandatory desktop-log redactor must remove. */
function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => value !== undefined && value.length > 0 && /KEY|SECRET|TOKEN|PASSWORD/iu.test(key))
    .map(([, value]) => value as string)
}
