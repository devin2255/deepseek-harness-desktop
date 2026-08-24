/** Electron entry binding cleanup mode or the normal retryable desktop lifecycle. */
import { app, shell } from 'electron'
import { createRequire } from 'node:module'
import { DesktopLog } from './desktop-log.ts'
import { startHarness } from './harness-supervisor.ts'
import { startDesktopMain } from './main-lifecycle.ts'
import { resolveRuntimeContext } from './runtime-context.ts'
import { createStartupWindow } from './startup-window.ts'
import {
  isUninstallCleanupInvocation,
  runUninstallCleanup,
} from './uninstall-cleanup.ts'
import { createDesktopWindow } from './window.ts'

const DESKTOP_CLEANUP_TIMEOUT_MS = 10_000
const DESKTOP_LOG_MAX_BYTES = 1_048_576
const DESKTOP_LOG_MAX_MESSAGE_CODE_UNITS = 16_384
const DESKTOP_LOG_MAX_METADATA_CODE_UNITS = 128
const desktopArguments = process.argv.slice(app.isPackaged ? 1 : 2)

if (isUninstallCleanupInvocation(desktopArguments)) {
  void runUninstallCleanup({ argv: desktopArguments, environment: process.env }).then(
    () => { app.exit(0) },
    () => {
      console.error('DeepSeek Harness uninstall cleanup was rejected or failed.')
      app.exit(1)
    },
  )
} else {
  startNormalDesktop()
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
    launchSpec: runtimeContext,
    platform: process.platform,
    startHarness: (launchSpec, options) => startHarness(launchSpec, options),
    createStartupWindow: actions => createStartupWindow(actions),
    createWindow: (endpoint, capability) => createDesktopWindow(endpoint, capability),
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

/** Select inherited secret values that the mandatory desktop-log redactor must remove. */
function sensitiveEnvironmentValues(environment: NodeJS.ProcessEnv): string[] {
  return Object.entries(environment)
    .filter(([key, value]) => value !== undefined && value.length > 0 && /KEY|SECRET|TOKEN|PASSWORD/iu.test(key))
    .map(([, value]) => value as string)
}
