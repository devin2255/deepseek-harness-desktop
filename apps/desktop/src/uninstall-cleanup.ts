/** Deletes product-owned mutable data only for an authenticated uninstaller child process. */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import { lstat, readdir, rename, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const CLEANUP_ARGUMENT_PREFIX = '--uninstall-delete-user-data='
const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const PRODUCT_DIRECTORY = 'DeepSeek Harness'

/** Environment key used as the second authorization channel for uninstall cleanup. */
export const UNINSTALL_CLEANUP_ENVIRONMENT_KEY = 'DSH_UNINSTALL_CLEANUP_TOKEN'

/** Process inputs accepted by the uninstall-only cleanup entry. */
export interface UninstallCleanupRequest {
  /** Application arguments after Electron's executable and application entry. */
  readonly argv: readonly string[]
  /** Environment inherited only by the uninstaller cleanup child. */
  readonly environment: NodeJS.ProcessEnv
}

/**
 * Detect any cleanup-mode switch so malformed requests fail closed instead of starting the app.
 * @param argv - Application arguments after the executable and development entry.
 * @returns Whether any argument selects uninstall cleanup mode.
 */
export function isUninstallCleanupInvocation(argv: readonly string[]): boolean {
  return argv.some(argument => argument.startsWith('--uninstall-delete-user-data'))
}

/**
 * Authenticate one exact cleanup request and remove only `%APPDATA%/DeepSeek Harness`.
 * @param request - Command arguments and the independent environment confirmation channel.
 * @returns `true` after the product root is absent.
 */
export async function runUninstallCleanup(request: UninstallCleanupRequest): Promise<true> {
  const argumentToken = parseAuthorizedToken(request.argv)
  const environmentToken = request.environment[UNINSTALL_CLEANUP_ENVIRONMENT_KEY]
  if (!isValidToken(environmentToken) || !tokensMatch(argumentToken, environmentToken)) {
    throw new Error('Uninstall cleanup confirmation was rejected')
  }
  const appData = resolveAppData(request.environment.APPDATA)
  const productRoot = resolve(appData, PRODUCT_DIRECTORY)
  assertContainedProductRoot(appData, productRoot)
  await assertOrdinaryDirectoryChain(appData)

  const productStatus = await lstatIfExists(productRoot)
  if (productStatus === undefined) return true
  assertOrdinaryDirectory(productRoot, productStatus)

  const quarantine = join(appData, `.DeepSeek Harness.uninstall-${randomBytes(16).toString('hex')}`)
  await rename(productRoot, quarantine)
  try {
    await assertOrdinaryDirectoryChain(appData)
    const quarantinedStatus = await lstat(quarantine)
    assertSameDirectory(productStatus, quarantinedStatus)
    await removeOwnedTree(quarantine)
  } catch (error: unknown) {
    await restoreQuarantine(productRoot, quarantine)
    throw new Error('Uninstall cleanup failed; product data was retained', { cause: error })
  }
  return true
}

/** Require one mode argument and no ordinary application arguments. */
function parseAuthorizedToken(argv: readonly string[]): string {
  if (argv.length !== 1 || !argv[0]?.startsWith(CLEANUP_ARGUMENT_PREFIX)) {
    throw new Error('Uninstall cleanup request must contain exactly one mode argument')
  }
  const token = argv[0].slice(CLEANUP_ARGUMENT_PREFIX.length)
  if (!isValidToken(token)) throw new Error('Uninstall cleanup confirmation has an invalid format')
  return token
}

/** Validate a 256-bit unpadded base64url confirmation encoding. */
function isValidToken(token: string | undefined): token is string {
  return token !== undefined && CONFIRMATION_TOKEN_PATTERN.test(token)
}

/** Compare equal-length validated tokens without content-dependent early exit. */
function tokensMatch(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'))
}

/** Resolve a non-root absolute roaming-data directory from the explicit environment only. */
function resolveAppData(value: string | undefined): string {
  if (value === undefined || value.trim() === '' || !isAbsolute(value)) {
    throw new Error('Uninstall cleanup requires an absolute APPDATA directory')
  }
  const resolved = resolve(value)
  if (resolved === parse(resolved).root) throw new Error('Uninstall cleanup refuses a filesystem-root APPDATA directory')
  return resolved
}

/** Prove the fixed product directory is a strict direct descendant of APPDATA. */
function assertContainedProductRoot(appData: string, productRoot: string): void {
  const child = relative(appData, productRoot)
  if (child !== PRODUCT_DIRECTORY || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Uninstall cleanup product root is outside APPDATA')
  }
  if (productRoot === parse(productRoot).root) throw new Error('Uninstall cleanup refuses a filesystem root')
}

/** Reject links, junctions, reparse-like links, and non-directories from the volume root downward. */
async function assertOrdinaryDirectoryChain(directory: string): Promise<void> {
  const root = parse(directory).root
  let current = root
  assertOrdinaryDirectory(current, await lstat(current))
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component)
    assertOrdinaryDirectory(current, await lstat(current))
  }
}

/** Reject anything other than an ordinary directory without following its final component. */
function assertOrdinaryDirectory(path: string, status: Stats): void {
  if (status.isSymbolicLink()) throw new Error(`Uninstall cleanup refuses a link or reparse point: ${path}`)
  if (!status.isDirectory()) throw new Error(`Uninstall cleanup path is not an ordinary directory: ${path}`)
}

/** Ensure the post-rename directory is the same owned filesystem object validated before mutation. */
function assertSameDirectory(before: Stats, after: Stats): void {
  assertOrdinaryDirectory('quarantined product root', after)
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Uninstall cleanup product root changed during validation')
  }
}

/** Delete a quarantined real directory without following link-shaped descendants. */
async function removeOwnedTree(directory: string): Promise<void> {
  assertOrdinaryDirectory(directory, await lstat(directory))
  for (const name of await readdir(directory)) {
    const child = join(directory, name)
    const status = await lstat(child)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      await unlink(child)
    } else {
      await removeOwnedTree(child)
    }
  }
  assertOrdinaryDirectory(directory, await lstat(directory))
  await rmdir(directory)
}

/** Restore the fixed product name when cleanup fails before the quarantine disappears. */
async function restoreQuarantine(productRoot: string, quarantine: string): Promise<void> {
  const quarantineStatus = await lstatIfExists(quarantine)
  const productStatus = await lstatIfExists(productRoot)
  if (quarantineStatus !== undefined && productStatus === undefined) {
    await rename(quarantine, productRoot)
  }
}

/** Read a final path component while treating only absence as optional. */
async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

/** Narrow filesystem errors without weakening other failures. */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
