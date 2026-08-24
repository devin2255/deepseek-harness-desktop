/** Authenticates uninstall cleanup and commits product-root removal without partial failure states. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  readdir,
  readlink,
  rename,
  rmdir,
  symlink,
  unlink,
} from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const CLEANUP_ARGUMENT_PREFIX = '--uninstall-delete-user-data='
const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const PRODUCT_DIRECTORY = 'DeepSeek Harness'
const SNAPSHOT_PREFIX = '.DeepSeek Harness.uninstall-validation-'
const COMMITTED_PREFIX = '.DeepSeek Harness.uninstall-committed-'

/** Environment key used as the second authorization channel for uninstall cleanup. */
export const UNINSTALL_CLEANUP_ENVIRONMENT_KEY = 'DSH_UNINSTALL_CLEANUP_TOKEN'

/** Process inputs and rollback-snapshot limits accepted by the uninstall-only entry. */
export interface UninstallCleanupRequest {
  /** Application arguments after Electron's executable and development entry. */
  readonly argv: readonly string[]
  /** Environment inherited only by the uninstaller cleanup child. */
  readonly environment: NodeJS.ProcessEnv
  /** Maximum files, directories, and links copied for destructive-operation validation. */
  readonly maxSnapshotEntries: number
}

/** Filesystem mutations replaceable only after authorization and fixed-root validation. */
export interface UninstallCleanupDependencies {
  /** Atomically move the fixed canonical product directory within APPDATA. */
  readonly rename: typeof rename
  /** Remove one empty ordinary directory from a validated tree. */
  readonly rmdir: typeof rmdir
  /** Remove one ordinary file or link without following it. */
  readonly unlink: typeof unlink
}

interface SnapshotBudget {
  entries: number
}

/** Detect any cleanup switch so malformed requests fail closed instead of starting the app. */
export function isUninstallCleanupInvocation(argv: readonly string[]): boolean {
  return argv.some(argument => argument.startsWith('--uninstall-delete-user-data'))
}

/**
 * Authenticate one exact cleanup request and atomically remove the canonical product root.
 * Destructive-operation failures discovered on the bounded physical snapshot reject before the
 * canonical directory moves. Once the canonical rename commits removal, later tombstone-purge
 * failures do not report a rollback-capable failure.
 * @param request - Arguments, environment confirmation, and explicit snapshot resource limits.
 * @param overrides - Filesystem mutations replaced by focused fault-injection tests.
 * @returns `true` after the canonical product root is absent.
 */
export async function runUninstallCleanup(
  request: UninstallCleanupRequest,
  overrides: Partial<UninstallCleanupDependencies> = {},
): Promise<true> {
  assertSnapshotLimits(request)
  const argumentToken = parseAuthorizedToken(request.argv)
  const environmentToken = request.environment[UNINSTALL_CLEANUP_ENVIRONMENT_KEY]
  if (!isValidToken(environmentToken) || !tokensMatch(argumentToken, environmentToken)) {
    throw new Error('Uninstall cleanup confirmation was rejected')
  }
  const dependencies: UninstallCleanupDependencies = { rename, rmdir, unlink, ...overrides }
  const appData = resolveAppData(request.environment.APPDATA)
  const productRoot = resolve(appData, PRODUCT_DIRECTORY)
  assertContainedProductRoot(appData, productRoot)
  await assertOrdinaryDirectoryChain(appData)
  const productStatus = await lstatIfExists(productRoot)
  if (productStatus === undefined) return true
  assertOrdinaryDirectory(productRoot, productStatus)

  const nonce = randomBytes(16).toString('hex')
  const snapshot = join(appData, `${SNAPSHOT_PREFIX}${nonce}`)
  const committed = join(appData, `${COMMITTED_PREFIX}${nonce}`)
  try {
    await createValidationSnapshot(productRoot, snapshot, request)
    await removeOwnedTree(snapshot, dependencies)
  } catch (error: unknown) {
    await removeOwnedTreeIfPresent(snapshot, { rename, rmdir, unlink })
    throw new Error('Uninstall cleanup snapshot destructive-operation validation failed', { cause: error })
  }

  await assertOrdinaryDirectoryChain(appData)
  assertSameDirectory(productStatus, await lstat(productRoot))
  try {
    await dependencies.rename(productRoot, committed)
  } catch (error: unknown) {
    throw new Error('Uninstall cleanup atomic commit failed', { cause: error })
  }
  try {
    assertSameDirectory(productStatus, await lstat(committed))
    await removeOwnedTree(committed, dependencies)
  } catch {
    // The canonical-path removal is already committed; reporting failure would promise rollback.
  }
  return true
}

function assertSnapshotLimits(request: UninstallCleanupRequest): void {
  if (!Number.isSafeInteger(request.maxSnapshotEntries) || request.maxSnapshotEntries <= 0) {
    throw new Error('Uninstall cleanup maxSnapshotEntries must be a positive safe integer')
  }
}

function parseAuthorizedToken(argv: readonly string[]): string {
  if (argv.length !== 1 || !argv[0]?.startsWith(CLEANUP_ARGUMENT_PREFIX)) {
    throw new Error('Uninstall cleanup request must contain exactly one mode argument')
  }
  const token = argv[0].slice(CLEANUP_ARGUMENT_PREFIX.length)
  if (!isValidToken(token)) throw new Error('Uninstall cleanup confirmation has an invalid format')
  return token
}

function isValidToken(token: string | undefined): token is string {
  return token !== undefined && CONFIRMATION_TOKEN_PATTERN.test(token)
}

function tokensMatch(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, 'ascii'), Buffer.from(right, 'ascii'))
}

function resolveAppData(value: string | undefined): string {
  if (value === undefined || value.trim() === '' || !isAbsolute(value)) {
    throw new Error('Uninstall cleanup requires an absolute APPDATA directory')
  }
  const resolved = resolve(value)
  if (resolved === parse(resolved).root) throw new Error('Uninstall cleanup refuses a filesystem-root APPDATA directory')
  return resolved
}

function assertContainedProductRoot(appData: string, productRoot: string): void {
  const child = relative(appData, productRoot)
  if (child !== PRODUCT_DIRECTORY || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('Uninstall cleanup product root is outside APPDATA')
  }
  if (productRoot === parse(productRoot).root) throw new Error('Uninstall cleanup refuses a filesystem root')
}

async function assertOrdinaryDirectoryChain(directory: string): Promise<void> {
  const root = parse(directory).root
  let current = root
  assertOrdinaryDirectory(current, await lstat(current))
  for (const component of relative(root, directory).split(sep).filter(Boolean)) {
    current = join(current, component)
    assertOrdinaryDirectory(current, await lstat(current))
  }
}

function assertOrdinaryDirectory(path: string, status: Stats): void {
  if (status.isSymbolicLink()) throw new Error(`Uninstall cleanup refuses a link or reparse point: ${path}`)
  if (!status.isDirectory()) throw new Error(`Uninstall cleanup path is not an ordinary directory: ${path}`)
}

function assertSameDirectory(before: Stats, after: Stats): void {
  assertOrdinaryDirectory('validated product root', after)
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Uninstall cleanup product root changed during validation')
  }
}

async function createValidationSnapshot(
  source: string,
  destination: string,
  limits: Pick<UninstallCleanupRequest, 'maxSnapshotEntries'>,
): Promise<void> {
  const budget: SnapshotBudget = { entries: 0 }
  await copyTree(source, destination, budget, limits)
}

async function copyTree(
  source: string,
  destination: string,
  budget: SnapshotBudget,
  limits: Pick<UninstallCleanupRequest, 'maxSnapshotEntries'>,
): Promise<void> {
  consumeEntry(budget, limits)
  const sourceStatus = await lstat(source)
  if (sourceStatus.isSymbolicLink()) {
    const target = await readlink(source)
    await symlink(target, destination, process.platform === 'win32' ? 'junction' : undefined)
    return
  }
  if (sourceStatus.isDirectory()) {
    await mkdir(destination)
    for (const name of await readdir(source)) await copyTree(join(source, name), join(destination, name), budget, limits)
    return
  }
  if (!sourceStatus.isFile()) throw new Error(`Uninstall cleanup snapshot refuses a special file: ${source}`)
  await link(source, destination)
}

function consumeEntry(
  budget: SnapshotBudget,
  limits: Pick<UninstallCleanupRequest, 'maxSnapshotEntries'>,
): void {
  budget.entries += 1
  if (budget.entries > limits.maxSnapshotEntries) throw new Error('Uninstall cleanup snapshot entry limit exceeded')
}

async function removeOwnedTree(directory: string, dependencies: UninstallCleanupDependencies): Promise<void> {
  assertOrdinaryDirectory(directory, await lstat(directory))
  for (const name of await readdir(directory)) {
    const child = join(directory, name)
    const status = await lstat(child)
    if (status.isSymbolicLink() || !status.isDirectory()) await dependencies.unlink(child)
    else await removeOwnedTree(child, dependencies)
  }
  assertOrdinaryDirectory(directory, await lstat(directory))
  await dependencies.rmdir(directory)
}

async function removeOwnedTreeIfPresent(path: string, dependencies: UninstallCleanupDependencies): Promise<void> {
  try {
    await removeOwnedTree(path, dependencies)
  } catch {
    // Validation residue is non-canonical; cleanup failure cannot justify mutating product data.
  }
}

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try { return await lstat(path) } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
