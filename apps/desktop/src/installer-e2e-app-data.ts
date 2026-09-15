/** Applies strictly test-owned Electron appData and home overrides for packaged installer E2E runs. */

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

export const INSTALLER_E2E_ROOT_ENVIRONMENT_KEY = 'DSH_INSTALLER_E2E_ROOT'
export const INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY = 'DSH_INSTALLER_E2E_OWNERSHIP'
export const INSTALLER_E2E_APP_DATA_MARKER = '.dsh-installer-e2e-owner'
const E2E_MODE_ENVIRONMENT_KEY = 'DSH_INSTALLER_E2E'
const E2E_ROOT_ARGUMENT = '--dsh-installer-e2e-root='
const E2E_OWNERSHIP_ARGUMENT = '--dsh-installer-e2e-ownership='
const OWNERSHIP_PATTERN = /^[A-Za-z0-9_-]{43}$/u

interface InstallerE2eApp {
  readonly isPackaged: boolean
  getPath(name: 'appData'): string
  setPath(name: 'appData' | 'home', path: string): void
}

/** Inputs used before normal desktop path resolution begins. */
export interface InstallerE2eAppDataRequest {
  readonly app: InstallerE2eApp
  readonly argv: readonly string[]
  readonly environment: NodeJS.ProcessEnv
  readonly platform: NodeJS.Platform
}

/**
 * Redirect Electron appData and home only when a Windows packaged E2E launch proves fixture ownership.
 * @param request - Electron application, explicit arguments, environment, and host platform.
 * @returns Desktop arguments with only authenticated E2E metadata removed.
 */
export function configureInstallerE2eAppData(request: InstallerE2eAppDataRequest): readonly string[] {
  const rootArguments = request.argv.filter(argument => argument.startsWith(E2E_ROOT_ARGUMENT))
  const ownershipArguments = request.argv.filter(argument => argument.startsWith(E2E_OWNERSHIP_ARGUMENT))
  const environmentRoot = request.environment[INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]
  const environmentOwnership = request.environment[INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]
  const mode = request.environment[E2E_MODE_ENVIRONMENT_KEY]
  const requested = rootArguments.length > 0 || ownershipArguments.length > 0
    || environmentRoot !== undefined || environmentOwnership !== undefined || mode !== undefined
  if (!requested) return request.argv

  try {
    configureRequestedAppData(
      request,
      rootArguments,
      ownershipArguments,
      environmentRoot,
      environmentOwnership,
      mode,
    )
  } catch {
    throw new Error('Invalid installer E2E data isolation request')
  }
  return request.argv.filter(argument => !argument.startsWith(E2E_ROOT_ARGUMENT) && !argument.startsWith(E2E_OWNERSHIP_ARGUMENT))
}

function configureRequestedAppData(
  request: InstallerE2eAppDataRequest,
  rootArguments: readonly string[],
  ownershipArguments: readonly string[],
  environmentRoot: string | undefined,
  environmentOwnership: string | undefined,
  mode: string | undefined,
): void {
  const reject = (): never => { throw new Error('rejected') }
  if (request.platform !== 'win32' || !request.app.isPackaged || mode !== '1') reject()
  if (rootArguments.length !== 1 || ownershipArguments.length !== 1) throw new Error('rejected')
  if (environmentRoot === undefined || environmentRoot === '') throw new Error('rejected')
  const argumentRoot = rootArguments[0]?.slice(E2E_ROOT_ARGUMENT.length)
  if (argumentRoot === undefined || argumentRoot === '') throw new Error('rejected')
  const argumentOwnership = ownershipArguments[0]?.slice(E2E_OWNERSHIP_ARGUMENT.length)
  if (
    argumentOwnership === undefined
    || environmentOwnership === undefined
    || argumentOwnership !== environmentOwnership
    || !OWNERSHIP_PATTERN.test(argumentOwnership)
  ) reject()
  if (!isAbsolute(argumentRoot) || !isAbsolute(environmentRoot)) throw new Error('rejected')

  const requestedRoot = resolve(argumentRoot)
  if (!samePath(requestedRoot, resolve(environmentRoot))) reject()
  if (!basename(requestedRoot).startsWith('dsh-installer-e2e-')) reject()

  assertOrdinaryDirectoryChain(parse(requestedRoot).root, requestedRoot, reject)
  if (!samePath(realpathSync(requestedRoot), requestedRoot)) reject()

  const marker = join(requestedRoot, INSTALLER_E2E_APP_DATA_MARKER)
  const markerStatus = lstatSync(marker)
  if (
    !markerStatus.isFile()
    || markerStatus.isSymbolicLink()
    || readFileSync(marker, 'utf8') !== `${argumentOwnership}\n`
  ) reject()

  const appData = join(requestedRoot, 'appdata', 'roaming')
  const home = join(requestedRoot, 'home')
  for (const path of [appData, home]) {
    assertOrdinaryDirectoryChain(requestedRoot, path, reject)
    if (!samePath(realpathSync(path), path)) reject()
  }
  const realProductData = join(resolve(request.app.getPath('appData')), 'DeepSeek Harness')
  if (
    samePath(appData, realProductData)
    || isStrictDescendant(appData, realProductData)
    || isStrictDescendant(realProductData, appData)
  ) reject()

  request.app.setPath('appData', appData)
  request.app.setPath('home', home)
}

function assertOrdinaryDirectoryChain(root: string, target: string, reject: () => never): void {
  let current = resolve(root)
  if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) reject()
  const child = relative(current, resolve(target))
  if (child === '' || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) reject()
  for (const component of child.split(sep)) {
    current = join(current, component)
    const status = lstatSync(current)
    if (!status.isDirectory() || status.isSymbolicLink()) reject()
  }
}

function isStrictDescendant(candidate: string, root: string): boolean {
  const child = relative(resolve(root), resolve(candidate))
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

function samePath(left: string, right: string): boolean {
  return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0
}
