/** Resolves immutable launch inputs and product-owned mutable paths for the desktop runtime. */

import { join } from 'node:path'

const PRODUCT_DIRECTORY = 'DeepSeek Harness'
const DEVELOPMENT_CLI_SPECIFIER = '@deepseek-ai/dsh/lib/bin.js'
/** Electron application paths and metadata consumed without importing the live singleton. */
export interface DesktopRuntimeApp {
  /** Whether Electron is running from a packaged application. */
  readonly isPackaged: boolean
  /** Return a stable Electron-owned host path. */
  getPath(name: 'appData' | 'home'): string
  /** Return the desktop application version. */
  getVersion(): string
}

/** Process values supplied explicitly at desktop composition. */
export interface DesktopRuntimeProcess {
  /** Electron's packaged resources directory. */
  readonly resourcesPath: string
  /** Parent environment copied and sanitized for the Harness child. */
  readonly environment: NodeJS.ProcessEnv
  /** Resolve the workspace CLI only for development launches. */
  readonly resolveDevelopmentCli: (specifier: string) => string
}

/** Immutable paths and environment used by one desktop application run. */
export interface DesktopRuntimeContext {
  /** Trusted Harness CLI entry selected for packaged or development execution. */
  readonly cliEntry: string
  /** Stable child working directory independent of a repository launch directory. */
  readonly cwd: string
  /** Sanitized child environment containing desktop-owned Harness metadata. */
  readonly environment: NodeJS.ProcessEnv
  /** Mutable Harness state directory owned by the desktop product. */
  readonly harnessHome: string
  /** Desktop log directory owned by the desktop product. */
  readonly logs: string
  /** Root directory for mutable desktop product data. */
  readonly productData: string
}

/**
 * Resolve all desktop runtime paths without mutating the parent environment.
 * @param app - Electron path and application metadata operations.
 * @param runtimeProcess - Explicit process resources, environment, and development resolver.
 * @returns Immutable launch inputs and product-owned paths for this application run.
 */
export function resolveRuntimeContext(
  app: DesktopRuntimeApp,
  runtimeProcess: DesktopRuntimeProcess,
): DesktopRuntimeContext {
  const productData = join(app.getPath('appData'), PRODUCT_DIRECTORY)
  const harnessHome = join(productData, 'Harness')
  const environment = { ...runtimeProcess.environment }
  delete environment.DSH_HOME
  delete environment.NODE_PATH
  delete environment.PNPM_HOME
  delete environment.INIT_CWD
  delete environment.npm_config_local_prefix
  delete environment.npm_package_json
  delete environment.npm_lifecycle_event
  delete environment.npm_lifecycle_script
  delete environment.PNPM_SCRIPT_SRC_DIR
  environment.DSH_HOME = harnessHome
  environment.DSH_DESKTOP_APP_VERSION = app.getVersion()

  return {
    cliEntry: app.isPackaged
      ? join(runtimeProcess.resourcesPath, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      : runtimeProcess.resolveDevelopmentCli(DEVELOPMENT_CLI_SPECIFIER),
    cwd: app.getPath('home'),
    environment,
    harnessHome,
    logs: join(productData, 'logs'),
    productData,
  }
}
