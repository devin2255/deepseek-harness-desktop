/** Authenticates uninstall cleanup and provides rollback for every reported failure. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Stats } from 'node:fs'
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const CLEANUP_ARGUMENT_PREFIX = '--uninstall-delete-user-data='
const CONFIRMATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u
const PRODUCT_DIRECTORY = 'DeepSeek Harness'
const ARCHIVE_PREFIX = '.DeepSeek Harness.uninstall-archive-'
const TOMBSTONE_PREFIX = '.DeepSeek Harness.uninstall-tombstone-'
const VALIDATION_PREFIX = '.DeepSeek Harness.uninstall-validation-'
const RESTORE_PREFIX = '.DeepSeek Harness.uninstall-restore-'
const ARCHIVE_MAGIC = Buffer.from('DSHUA001', 'ascii')
const ARCHIVE_END = 0
const ARCHIVE_DIRECTORY = 1
const ARCHIVE_FILE = 2
const IO_CHUNK_BYTES = 64 * 1024
const RESTORE_ATTEMPTS = 3

/** Environment key used as the second authorization channel for uninstall cleanup. */
export const UNINSTALL_CLEANUP_ENVIRONMENT_KEY = 'DSH_UNINSTALL_CLEANUP_TOKEN'

/** Process inputs and archive limits accepted by the uninstall-only entry. */
export interface UninstallCleanupRequest {
  /** Application arguments after Electron's executable and development entry. */
  readonly argv: readonly string[]
  /** Environment inherited only by the uninstaller cleanup child. */
  readonly environment: NodeJS.ProcessEnv
  /** Maximum files and directories recorded in one streaming recovery archive. */
  readonly maxSnapshotEntries: number
}

/** Filesystem mutations replaceable only after authorization and fixed-root validation. */
export interface UninstallCleanupDependencies {
  /** Atomically move the fixed canonical product directory within APPDATA. */
  readonly rename: typeof rename
  /** Remove one empty ordinary directory from a validated tree. */
  readonly rmdir: typeof rmdir
  /** Remove one ordinary file without following it. */
  readonly unlink: typeof unlink
}

interface ArchiveWriteState {
  entries: number
  position: number
}

interface ArchiveReadState {
  entries: number
  position: number
  readonly paths: Set<string>
}

type ReservedArtifactKind = 'archive' | 'tombstone' | 'validation' | 'restore'

interface ReservedArtifact {
  readonly id: string
  readonly kind: ReservedArtifactKind
  readonly path: string
}

interface ReservedTransaction {
  readonly id: string
  readonly archive?: ReservedArtifact
  readonly tombstone?: ReservedArtifact
  readonly validation?: ReservedArtifact
  readonly restore?: ReservedArtifact
}

/** Detect any cleanup switch so malformed requests fail closed instead of starting the app. */
export function isUninstallCleanupInvocation(argv: readonly string[]): boolean {
  return argv.some(argument => argument.startsWith('--uninstall-delete-user-data'))
}

/**
 * Authenticate one exact cleanup request and delete the canonical product data transactionally.
 * A streaming archive is fsynced and restored once for verification before mutation. Any later
 * tombstone or final archive deletion failure restores and atomically republishes the canonical
 * tree before rejecting. Success means canonical data and every transaction artifact are absent.
 * @param request - Arguments, environment confirmation, and explicit archive entry limit.
 * @param overrides - Filesystem mutations replaced by focused fault-injection tests.
 * @returns `true` only after canonical data and the recovery archive are deleted.
 */
export async function runUninstallCleanup(
  request: UninstallCleanupRequest,
  overrides: Partial<UninstallCleanupDependencies> = {},
): Promise<true> {
  assertEntryLimit(request.maxSnapshotEntries)
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
  await recoverInterruptedTransactions(appData, productRoot, request.maxSnapshotEntries)
  await assertNoReservedArtifacts(appData)
  const productStatus = await lstatIfExists(productRoot)
  if (productStatus === undefined) return true
  assertOrdinaryDirectory(productRoot, productStatus)

  const transactionId = randomBytes(16).toString('hex')
  const archivePath = join(appData, `${ARCHIVE_PREFIX}${transactionId}`)
  const tombstonePath = join(appData, `${TOMBSTONE_PREFIX}${transactionId}`)
  const validationPath = join(appData, `${VALIDATION_PREFIX}${transactionId}`)
  await createArchive(productRoot, archivePath, transactionId, request.maxSnapshotEntries)
  try {
    await restoreArchive(archivePath, validationPath, transactionId, request.maxSnapshotEntries)
    await removeOwnedTree(validationPath, dependencies)
  } catch (error: unknown) {
    try {
      if (await lstatIfExists(validationPath) !== undefined) await removeOwnedTree(validationPath, productionDependencies())
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        `Fatal uninstall cleanup validation recovery failure; verified archive retained at ${archivePath}`,
        { cause: error },
      )
    }
    await unlinkIfPresent(archivePath)
    throw new Error('Uninstall cleanup archive validation failed before mutation', { cause: error })
  }

  await assertOrdinaryDirectoryChain(appData)
  assertSameDirectory(productStatus, await lstat(productRoot))
  try {
    await dependencies.rename(productRoot, tombstonePath)
  } catch (error: unknown) {
    await unlinkIfPresent(archivePath)
    throw new Error('Uninstall cleanup atomic commit rename failed before mutation', { cause: error })
  }

  try {
    assertSameDirectory(productStatus, await lstat(tombstonePath))
    await removeOwnedTree(tombstonePath, dependencies)
  } catch (error: unknown) {
    await restoreCanonicalOrThrow(archivePath, productRoot, transactionId, request.maxSnapshotEntries, error)
    try {
      if (await lstatIfExists(tombstonePath) !== undefined) await removeOwnedTree(tombstonePath, productionDependencies())
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        `Fatal uninstall cleanup tombstone recovery failure; verified archive retained at ${archivePath}`,
        { cause: error },
      )
    }
    await unlinkIfPresent(archivePath)
    throw new Error('Uninstall cleanup transaction failed and canonical data was restored', { cause: error })
  }

  try {
    await dependencies.unlink(archivePath)
  } catch (error: unknown) {
    await restoreCanonicalOrThrow(archivePath, productRoot, transactionId, request.maxSnapshotEntries, error)
    await unlinkIfPresent(archivePath)
    throw new Error('Uninstall cleanup final commit failed and canonical data was restored', { cause: error })
  }
  await assertNoReservedArtifacts(appData)
  return true
}

function productionDependencies(): UninstallCleanupDependencies {
  return { rename, rmdir, unlink }
}

function assertEntryLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
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
  if (status.isSymbolicLink()) throw new Error(`Uninstall cleanup refuses a link, junction, or reparse point: ${path}`)
  if (!status.isDirectory()) throw new Error(`Uninstall cleanup path is not an ordinary directory: ${path}`)
}

function assertSameDirectory(before: Stats, after: Stats): void {
  assertOrdinaryDirectory('validated product root', after)
  if (before.dev !== after.dev || before.ino !== after.ino) {
    throw new Error('Uninstall cleanup product root changed during validation')
  }
}

async function createArchive(source: string, archivePath: string, transactionId: string, maxEntries: number): Promise<void> {
  const archive = await open(archivePath, 'wx', 0o600)
  const state: ArchiveWriteState = { entries: 0, position: 0 }
  try {
    consumeEntry(state, maxEntries)
    state.position = await writeBuffer(archive, Buffer.concat([ARCHIVE_MAGIC, Buffer.from(transactionId, 'ascii')]), state.position)
    await appendDirectory(archive, source, '', state, maxEntries)
    state.position = await writeBuffer(archive, Buffer.from([ARCHIVE_END]), state.position)
    await archive.sync()
  } catch (error: unknown) {
    await archive.close().catch(() => {})
    await unlinkIfPresent(archivePath)
    throw error
  }
  await archive.close()
}

async function appendDirectory(
  archive: FileHandle,
  source: string,
  relativePath: string,
  state: ArchiveWriteState,
  maxEntries: number,
): Promise<void> {
  const before = await lstat(source)
  assertOrdinaryDirectory(source, before)
  for (const name of (await readdir(source)).sort()) {
    const childSource = join(source, name)
    const childRelative = relativePath === '' ? name : `${relativePath}/${name}`
    const status = await lstat(childSource)
    consumeEntry(state, maxEntries)
    if (status.isSymbolicLink()) throw new Error(`Uninstall cleanup refuses a descendant link or junction: ${childSource}`)
    if (status.isDirectory()) {
      state.position = await writeRecordPath(archive, ARCHIVE_DIRECTORY, childRelative, state.position)
      await appendDirectory(archive, childSource, childRelative, state, maxEntries)
    } else if (status.isFile()) {
      state.position = await appendFile(archive, childSource, childRelative, status, state.position)
    } else {
      throw new Error(`Uninstall cleanup archive refuses a special file: ${childSource}`)
    }
  }
  assertSameDirectory(before, await lstat(source))
}

function consumeEntry(state: { entries: number }, maxEntries: number): void {
  state.entries += 1
  if (state.entries > maxEntries) throw new Error('Uninstall cleanup recovery archive snapshot entry limit exceeded')
}

async function writeRecordPath(archive: FileHandle, type: number, path: string, position: number): Promise<number> {
  const pathBytes = Buffer.from(path, 'utf8')
  if (pathBytes.length === 0 || pathBytes.length > 0xffff_ffff) throw new Error('Uninstall cleanup archive path is invalid')
  const header = Buffer.alloc(5)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(pathBytes.length, 1)
  return writeBuffer(archive, pathBytes, await writeBuffer(archive, header, position))
}

async function appendFile(
  archive: FileHandle,
  source: string,
  relativePath: string,
  expected: Stats,
  position: number,
): Promise<number> {
  let next = await writeRecordPath(archive, ARCHIVE_FILE, relativePath, position)
  const size = Buffer.alloc(8)
  size.writeBigUInt64BE(BigInt(expected.size))
  next = await writeBuffer(archive, size, next)
  const input = await open(source, 'r')
  const hash = createHash('sha256')
  try {
    const opened = await input.stat()
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino || opened.size !== expected.size) {
      throw new Error(`Uninstall cleanup source file changed during archive: ${source}`)
    }
    const chunk = Buffer.allocUnsafe(IO_CHUNK_BYTES)
    let sourcePosition = 0
    while (sourcePosition < expected.size) {
      const read = await input.read(chunk, 0, Math.min(chunk.length, expected.size - sourcePosition), sourcePosition)
      if (read.bytesRead === 0) throw new Error(`Uninstall cleanup source file ended early: ${source}`)
      const bytes = chunk.subarray(0, read.bytesRead)
      hash.update(bytes)
      next = await writeBuffer(archive, bytes, next)
      sourcePosition += read.bytesRead
    }
  } finally {
    await input.close()
  }
  return writeBuffer(archive, hash.digest(), next)
}

async function restoreArchive(
  archivePath: string,
  destination: string,
  transactionId: string,
  maxEntries: number,
): Promise<void> {
  const archive = await open(archivePath, 'r')
  const state: ArchiveReadState = { entries: 0, paths: new Set(), position: 0 }
  let destinationCreated = false
  try {
    const prefix = await readExact(archive, ARCHIVE_MAGIC.length + transactionId.length, state)
    if (!prefix.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)
      || prefix.subarray(ARCHIVE_MAGIC.length).toString('ascii') !== transactionId) {
      throw new Error('Uninstall cleanup archive identity is invalid')
    }
    await mkdir(destination)
    destinationCreated = true
    while (true) {
      const type = (await readExact(archive, 1, state)).readUInt8(0)
      if (type === ARCHIVE_END) break
      if (type !== ARCHIVE_DIRECTORY && type !== ARCHIVE_FILE) throw new Error('Uninstall cleanup archive record type is invalid')
      consumeEntry(state, maxEntries)
      const pathLength = (await readExact(archive, 4, state)).readUInt32BE(0)
      const relativePath = (await readExact(archive, pathLength, state)).toString('utf8')
      assertArchivePath(relativePath, state.paths)
      const target = archiveTarget(destination, relativePath)
      if (type === ARCHIVE_DIRECTORY) await mkdir(target)
      else await restoreFile(archive, target, state)
    }
    const trailing = Buffer.alloc(1)
    if ((await archive.read(trailing, 0, 1, state.position)).bytesRead !== 0) {
      throw new Error('Uninstall cleanup archive has trailing data')
    }
  } catch (error: unknown) {
    await archive.close().catch(() => {})
    if (destinationCreated) await removeOwnedTreeIfPresent(destination, productionDependencies())
    throw error
  }
  await archive.close()
}

function assertArchivePath(path: string, paths: Set<string>): void {
  if (path === '' || path.includes('\\') || path.split('/').some(part => part === '' || part === '.' || part === '..')) {
    throw new Error('Uninstall cleanup archive path is unsafe')
  }
  if (paths.has(path)) throw new Error('Uninstall cleanup archive contains duplicate paths')
  paths.add(path)
}

function archiveTarget(root: string, path: string): string {
  const target = resolve(root, ...path.split('/'))
  const child = relative(root, target)
  if (child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error('Uninstall cleanup archive target escapes restore root')
  return target
}

async function restoreFile(archive: FileHandle, target: string, state: ArchiveReadState): Promise<void> {
  const encodedSize = (await readExact(archive, 8, state)).readBigUInt64BE(0)
  if (encodedSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Uninstall cleanup archive file is too large')
  const size = Number(encodedSize)
  const output = await open(target, 'wx', 0o600)
  const hash = createHash('sha256')
  try {
    let remaining = size
    let outputPosition = 0
    while (remaining > 0) {
      const bytes = await readExact(archive, Math.min(IO_CHUNK_BYTES, remaining), state)
      hash.update(bytes)
      await writeBuffer(output, bytes, outputPosition)
      outputPosition += bytes.length
      remaining -= bytes.length
    }
    await output.sync()
  } finally {
    await output.close()
  }
  const expectedDigest = await readExact(archive, 32, state)
  if (!timingSafeEqual(hash.digest(), expectedDigest)) throw new Error('Uninstall cleanup archive file checksum failed')
}

async function writeBuffer(handle: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let offset = 0
  while (offset < buffer.length) {
    const written = await handle.write(buffer, offset, buffer.length - offset, position + offset)
    if (written.bytesWritten === 0) throw new Error('Uninstall cleanup archive write made no progress')
    offset += written.bytesWritten
  }
  return position + buffer.length
}

async function readExact(handle: FileHandle, length: number, state: { position: number }): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const read = await handle.read(buffer, offset, length - offset, state.position + offset)
    if (read.bytesRead === 0) throw new Error('Uninstall cleanup archive ended early')
    offset += read.bytesRead
  }
  state.position += length
  return buffer
}

async function restoreCanonicalOrThrow(
  archivePath: string,
  productRoot: string,
  transactionId: string,
  maxEntries: number,
  originalError: unknown,
): Promise<void> {
  let lastError: unknown = originalError
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    const restorePath = join(dirname(productRoot), `${RESTORE_PREFIX}${transactionId}-${randomBytes(8).toString('hex')}`)
    let archiveRestored = false
    try {
      await restoreArchive(archivePath, restorePath, transactionId, maxEntries)
      archiveRestored = true
      if (await lstatIfExists(productRoot) !== undefined) throw new Error('Canonical product root unexpectedly exists during restore')
      await rename(restorePath, productRoot)
      return
    } catch (error: unknown) {
      lastError = error
      if (archiveRestored) await removeOwnedTreeIfPresent(restorePath, productionDependencies())
    }
  }
  throw new AggregateError(
    [originalError, lastError],
    `Fatal uninstall cleanup recovery failure; verified archive retained at ${archivePath}`,
    { cause: originalError },
  )
}

async function recoverInterruptedTransactions(appData: string, productRoot: string, maxEntries: number): Promise<void> {
  const transaction = await scanReservedTransaction(appData)
  if (transaction === undefined) return
  if (transaction.archive === undefined) {
    throw new Error('Uninstall cleanup refuses an orphan transaction artifact')
  }
  const verificationPath = join(appData, `${RESTORE_PREFIX}${transaction.id}-${randomBytes(8).toString('hex')}`)
  await restoreArchive(transaction.archive.path, verificationPath, transaction.id, maxEntries)
  if (await lstatIfExists(productRoot) === undefined) await rename(verificationPath, productRoot)
  else await removeOwnedTree(verificationPath, productionDependencies())
  for (const residue of [transaction.validation, transaction.restore]) {
    if (residue !== undefined) await removeOwnedTree(residue.path, productionDependencies())
  }
  if (transaction.tombstone !== undefined) await removeOwnedTree(transaction.tombstone.path, productionDependencies())
  await unlinkIfPresent(transaction.archive.path)
}

async function assertNoReservedArtifacts(appData: string): Promise<void> {
  if (await scanReservedTransaction(appData) !== undefined) {
    throw new Error('Uninstall cleanup transaction artifacts remain after deletion')
  }
}

async function scanReservedTransaction(appData: string): Promise<ReservedTransaction | undefined> {
  const artifacts: ReservedArtifact[] = []
  for (const name of await readdir(appData)) {
    const parsed = parseReservedArtifact(name)
    if (parsed === undefined) continue
    const path = join(appData, name)
    const status = await lstat(path)
    if (parsed.kind === 'archive') {
      if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error('Uninstall cleanup archive artifact is not an ordinary file')
      }
    } else if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error('Uninstall cleanup transaction artifact is not an ordinary directory')
    }
    artifacts.push({ ...parsed, path })
  }
  if (artifacts.length === 0) return undefined
  const ids = new Set(artifacts.map(artifact => artifact.id))
  if (ids.size !== 1) throw new Error('Uninstall cleanup refuses conflicting transaction artifacts')
  const id = artifacts[0]?.id
  if (id === undefined) return undefined
  const transaction: {
    id: string
    archive?: ReservedArtifact
    tombstone?: ReservedArtifact
    validation?: ReservedArtifact
    restore?: ReservedArtifact
  } = { id }
  for (const artifact of artifacts) {
    if (transaction[artifact.kind] !== undefined) {
      throw new Error('Uninstall cleanup refuses duplicate transaction artifacts')
    }
    transaction[artifact.kind] = artifact
  }
  return transaction
}

function parseReservedArtifact(name: string): Pick<ReservedArtifact, 'id' | 'kind'> | undefined {
  const prefixes: readonly [ReservedArtifactKind, string][] = [
    ['archive', ARCHIVE_PREFIX],
    ['tombstone', TOMBSTONE_PREFIX],
    ['validation', VALIDATION_PREFIX],
    ['restore', RESTORE_PREFIX],
  ]
  for (const [kind, prefix] of prefixes) {
    if (!name.startsWith(prefix)) continue
    const suffix = name.slice(prefix.length)
    const match = kind === 'restore'
      ? /^([0-9a-f]{32})-[0-9a-f]{16}$/u.exec(suffix)
      : /^([0-9a-f]{32})$/u.exec(suffix)
    const id = match?.[1]
    if (id === undefined) throw new Error('Uninstall cleanup refuses an invalid reserved transaction artifact')
    return { id, kind }
  }
  return undefined
}

async function removeOwnedTree(directory: string, dependencies: UninstallCleanupDependencies): Promise<void> {
  assertOrdinaryDirectory(directory, await lstat(directory))
  for (const name of await readdir(directory)) {
    const child = join(directory, name)
    const status = await lstat(child)
    if (status.isSymbolicLink()) throw new Error(`Uninstall cleanup refuses a descendant link or junction: ${child}`)
    if (status.isDirectory()) await removeOwnedTree(child, dependencies)
    else if (status.isFile()) await dependencies.unlink(child)
    else throw new Error(`Uninstall cleanup refuses a special file: ${child}`)
  }
  assertOrdinaryDirectory(directory, await lstat(directory))
  await dependencies.rmdir(directory)
}

async function removeOwnedTreeIfPresent(path: string, dependencies: UninstallCleanupDependencies): Promise<void> {
  try { await removeOwnedTree(path, dependencies) } catch { /* Recovery residue remains private and never follows links. */ }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try { await unlink(path) } catch (error: unknown) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
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
