/** Authenticates uninstall cleanup and provides rollback for every reported failure. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isUtf8 } from 'node:buffer'
import type { Stats } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rmdir,
  unlink,
  utimes,
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
const ARCHIVE_MAGIC = Buffer.from('DSHUA002', 'ascii')
const ARCHIVE_END = 0
const ARCHIVE_DIRECTORY = 1
const ARCHIVE_FILE = 2
const IO_CHUNK_BYTES = 64 * 1024
const ARCHIVE_HEADER_BYTES = 56
const ARCHIVE_METADATA_BYTES = 12
const ARCHIVE_CHECKSUM_BYTES = 32
const MAX_ARCHIVE_PATH_UTF8_BYTES = 64 * 1024
const MAX_ARCHIVE_PATH_CODE_UNITS = 32_767
const MAX_ARCHIVE_PATH_METADATA_BYTES = 16 * 1024 * 1024
const MAX_TIMESTAMP_MS = 8_640_000_000_000_000
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
  /** Apply portable permission bits to a verified recovery entry before publication. */
  readonly chmod: typeof chmod
  /** Atomically move the fixed canonical product directory within APPDATA. */
  readonly rename: typeof rename
  /** Remove one empty ordinary directory from a validated tree. */
  readonly rmdir: typeof rmdir
  /** Remove one ordinary file without following it. */
  readonly unlink: typeof unlink
  /** Apply the archived modification time to a verified recovery entry before publication. */
  readonly utimes: typeof utimes
}

interface ArchiveWriteState {
  entries: number
  pathMetadataBytes: number
  position: number
}

interface ArchiveReadState {
  entries: number
  pathMetadataBytes: number
  position: number
  readonly size: number
  readonly paths: Set<string>
}

interface ArchivedMetadata {
  readonly mode: number
  readonly mtimeMs: number
}

interface ArchivedDirectoryMetadata extends ArchivedMetadata {
  readonly path: string
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
  const dependencies: UninstallCleanupDependencies = { chmod, rename, rmdir, unlink, utimes, ...overrides }
  const appData = resolveAppData(request.environment.APPDATA)
  const productRoot = resolve(appData, PRODUCT_DIRECTORY)
  assertContainedProductRoot(appData, productRoot)
  await assertOrdinaryDirectoryChain(appData)
  await recoverInterruptedTransactions(appData, productRoot, request.maxSnapshotEntries, dependencies)
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
    await restoreArchive(archivePath, validationPath, transactionId, request.maxSnapshotEntries, dependencies)
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
    await restoreCanonicalOrThrow(archivePath, productRoot, transactionId, request.maxSnapshotEntries, error, dependencies)
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
    await restoreCanonicalOrThrow(archivePath, productRoot, transactionId, request.maxSnapshotEntries, error, dependencies)
    await unlinkIfPresent(archivePath)
    throw new Error('Uninstall cleanup final commit failed and canonical data was restored', { cause: error })
  }
  await assertNoReservedArtifacts(appData)
  return true
}

function productionDependencies(): UninstallCleanupDependencies {
  return { chmod, rename, rmdir, unlink, utimes }
}

function assertEntryLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 0xffff_ffff) {
    throw new Error('Uninstall cleanup maxSnapshotEntries must be a positive 32-bit integer')
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

function assertSameArchivedMetadata(before: Stats, after: Stats): void {
  if (before.mode !== after.mode || before.mtimeMs !== after.mtimeMs) {
    throw new Error('Uninstall cleanup source directory metadata changed during archive')
  }
}

async function createArchive(source: string, archivePath: string, transactionId: string, maxEntries: number): Promise<void> {
  const archive = await open(archivePath, 'wx', 0o600)
  const state: ArchiveWriteState = { entries: 0, pathMetadataBytes: 0, position: 0 }
  try {
    const rootStatus = await lstat(source)
    assertOrdinaryDirectory(source, rootStatus)
    consumeEntry(state, maxEntries)
    const header = Buffer.alloc(ARCHIVE_HEADER_BYTES)
    ARCHIVE_MAGIC.copy(header, 0)
    Buffer.from(transactionId, 'ascii').copy(header, ARCHIVE_MAGIC.length)
    encodeMetadata(header, 44, rootStatus)
    state.position = await writeBuffer(archive, header, state.position)
    await appendDirectory(archive, source, '', state, maxEntries)
    state.position = await writeBuffer(archive, Buffer.from([ARCHIVE_END]), state.position)
    const encodedEntryCount = Buffer.alloc(4)
    encodedEntryCount.writeUInt32BE(state.entries)
    await writeBuffer(archive, encodedEntryCount, 40)
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
      state.position = await writeRecordHeader(archive, ARCHIVE_DIRECTORY, childRelative, status, state)
      await appendDirectory(archive, childSource, childRelative, state, maxEntries)
    } else if (status.isFile()) {
      state.position = await appendFile(archive, childSource, childRelative, status, state)
    } else {
      throw new Error(`Uninstall cleanup archive refuses a special file: ${childSource}`)
    }
  }
  const completed = await lstat(source)
  assertSameDirectory(before, completed)
  assertSameArchivedMetadata(before, completed)
}

function consumeEntry(state: { entries: number }, maxEntries: number): void {
  state.entries += 1
  if (state.entries > maxEntries) throw new Error('Uninstall cleanup recovery archive snapshot entry limit exceeded')
}

async function writeRecordHeader(
  archive: FileHandle,
  type: number,
  path: string,
  metadata: Pick<Stats, 'mode' | 'mtimeMs'>,
  state: ArchiveWriteState,
): Promise<number> {
  const pathBytes = Buffer.from(path, 'utf8')
  if (pathBytes.length === 0 || pathBytes.length > MAX_ARCHIVE_PATH_UTF8_BYTES || path.length > MAX_ARCHIVE_PATH_CODE_UNITS) {
    throw new Error('Uninstall cleanup archive path exceeds the metadata limit')
  }
  consumePathMetadata(state, pathBytes.length)
  const header = Buffer.alloc(5)
  header.writeUInt8(type, 0)
  header.writeUInt32BE(pathBytes.length, 1)
  const encodedMetadata = Buffer.alloc(ARCHIVE_METADATA_BYTES)
  encodeMetadata(encodedMetadata, 0, metadata)
  return writeBuffer(
    archive,
    encodedMetadata,
    await writeBuffer(archive, pathBytes, await writeBuffer(archive, header, state.position)),
  )
}

function encodeMetadata(buffer: Buffer, offset: number, metadata: Pick<Stats, 'mode' | 'mtimeMs'>): void {
  const mode = metadata.mode & 0o7777
  if (!Number.isFinite(metadata.mtimeMs) || Math.abs(metadata.mtimeMs) > MAX_TIMESTAMP_MS) {
    throw new Error('Uninstall cleanup source mtime is outside the portable range')
  }
  buffer.writeUInt32BE(mode, offset)
  buffer.writeDoubleBE(metadata.mtimeMs, offset + 4)
}

async function appendFile(
  archive: FileHandle,
  source: string,
  relativePath: string,
  expected: Stats,
  state: ArchiveWriteState,
): Promise<number> {
  if (!Number.isSafeInteger(expected.size) || expected.size < 0) {
    throw new Error('Uninstall cleanup source file is too large')
  }
  let next = await writeRecordHeader(archive, ARCHIVE_FILE, relativePath, expected, state)
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
    const completed = await input.stat()
    if (completed.dev !== expected.dev || completed.ino !== expected.ino || completed.size !== expected.size
      || completed.mtimeMs !== expected.mtimeMs || completed.mode !== expected.mode) {
      throw new Error(`Uninstall cleanup source file changed during archive: ${source}`)
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
  dependencies: Pick<UninstallCleanupDependencies, 'chmod' | 'utimes'>,
): Promise<void> {
  const archive = await open(archivePath, 'r')
  const archiveStatus = await archive.stat()
  if (!Number.isSafeInteger(archiveStatus.size) || archiveStatus.size < ARCHIVE_HEADER_BYTES + 1) {
    await archive.close()
    throw new Error('Uninstall cleanup archive header is truncated')
  }
  const state: ArchiveReadState = {
    entries: 0,
    pathMetadataBytes: 0,
    paths: new Set(),
    position: 0,
    size: archiveStatus.size,
  }
  let destinationCreated = false
  try {
    const header = await readExact(archive, ARCHIVE_HEADER_BYTES, state)
    if (!header.subarray(0, ARCHIVE_MAGIC.length).equals(ARCHIVE_MAGIC)
      || header.subarray(ARCHIVE_MAGIC.length, 40).toString('ascii') !== transactionId) {
      throw new Error('Uninstall cleanup archive identity is invalid')
    }
    const declaredEntries = header.readUInt32BE(40)
    if (declaredEntries < 1 || declaredEntries > maxEntries) {
      throw new Error('Uninstall cleanup archive entry count exceeds the configured limit')
    }
    const rootMetadata = decodeMetadata(header, 44)
    consumeEntry(state, maxEntries)
    await mkdir(destination)
    destinationCreated = true
    const directories: ArchivedDirectoryMetadata[] = [{ path: destination, ...rootMetadata }]
    while (true) {
      const type = (await readExact(archive, 1, state)).readUInt8(0)
      if (type === ARCHIVE_END) break
      if (type !== ARCHIVE_DIRECTORY && type !== ARCHIVE_FILE) throw new Error('Uninstall cleanup archive record type is invalid')
      consumeEntry(state, maxEntries)
      if (state.entries > declaredEntries) throw new Error('Uninstall cleanup archive entry count does not match its records')
      const pathLength = (await readExact(archive, 4, state)).readUInt32BE(0)
      if (pathLength === 0 || pathLength > MAX_ARCHIVE_PATH_UTF8_BYTES) {
        throw new Error('Uninstall cleanup archive path exceeds the metadata limit')
      }
      consumePathMetadata(state, pathLength)
      const pathBytes = await readExact(archive, pathLength, state)
      if (!isUtf8(pathBytes)) throw new Error('Uninstall cleanup archive path is not valid UTF-8')
      const relativePath = pathBytes.toString('utf8')
      if (relativePath.length > MAX_ARCHIVE_PATH_CODE_UNITS) {
        throw new Error('Uninstall cleanup archive path exceeds the metadata limit')
      }
      assertArchivePath(relativePath, state.paths)
      const metadata = decodeMetadata(await readExact(archive, ARCHIVE_METADATA_BYTES, state), 0)
      const target = archiveTarget(destination, relativePath)
      if (type === ARCHIVE_DIRECTORY) {
        await mkdir(target)
        directories.push({ path: target, ...metadata })
      } else {
        await restoreFile(archive, target, metadata, state, dependencies)
      }
    }
    if (state.entries !== declaredEntries) throw new Error('Uninstall cleanup archive entry count does not match its records')
    if (state.position !== state.size) throw new Error('Uninstall cleanup archive has trailing data')
    for (const metadata of directories.reverse()) await applyMetadata(metadata.path, metadata, dependencies)
    const completedStatus = await archive.stat()
    if (completedStatus.dev !== archiveStatus.dev || completedStatus.ino !== archiveStatus.ino
      || completedStatus.size !== archiveStatus.size || completedStatus.mtimeMs !== archiveStatus.mtimeMs) {
      throw new Error('Uninstall cleanup archive changed during verification')
    }
  } catch (error: unknown) {
    await archive.close().catch(() => {})
    if (destinationCreated) await removeOwnedTreeIfPresent(destination, productionDependencies())
    throw error
  }
  await archive.close()
}

function decodeMetadata(buffer: Buffer, offset: number): ArchivedMetadata {
  const mode = buffer.readUInt32BE(offset)
  const mtimeMs = buffer.readDoubleBE(offset + 4)
  if (mode > 0o7777 || !Number.isFinite(mtimeMs) || Math.abs(mtimeMs) > MAX_TIMESTAMP_MS) {
    throw new Error('Uninstall cleanup archive metadata is invalid')
  }
  return { mode, mtimeMs }
}

function consumePathMetadata(state: { pathMetadataBytes: number }, bytes: number): void {
  state.pathMetadataBytes += bytes
  if (!Number.isSafeInteger(state.pathMetadataBytes) || state.pathMetadataBytes > MAX_ARCHIVE_PATH_METADATA_BYTES) {
    throw new Error('Uninstall cleanup archive path metadata exceeds the total limit')
  }
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

async function restoreFile(
  archive: FileHandle,
  target: string,
  metadata: ArchivedMetadata,
  state: ArchiveReadState,
  dependencies: Pick<UninstallCleanupDependencies, 'chmod' | 'utimes'>,
): Promise<void> {
  const encodedSize = (await readExact(archive, 8, state)).readBigUInt64BE(0)
  const remainingContentBytes = remainingArchiveBytes(state) - ARCHIVE_CHECKSUM_BYTES
  if (remainingContentBytes < 0 || encodedSize > BigInt(remainingContentBytes)
    || encodedSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('Uninstall cleanup archive file content is truncated or too large')
  }
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
  const expectedDigest = await readExact(archive, ARCHIVE_CHECKSUM_BYTES, state)
  if (!timingSafeEqual(hash.digest(), expectedDigest)) throw new Error('Uninstall cleanup archive file checksum failed')
  await applyMetadata(target, metadata, dependencies)
}

async function applyMetadata(
  path: string,
  metadata: ArchivedMetadata,
  dependencies: Pick<UninstallCleanupDependencies, 'chmod' | 'utimes'>,
): Promise<void> {
  await dependencies.chmod(path, metadata.mode)
  const mtime = new Date(metadata.mtimeMs)
  await dependencies.utimes(path, mtime, mtime)
  const restored = await lstat(path)
  if (restored.isSymbolicLink() || Math.abs(restored.mtimeMs - metadata.mtimeMs) > 2_000
    || (process.platform !== 'win32' && (restored.mode & 0o7777) !== metadata.mode)) {
    throw new Error('Uninstall cleanup restored metadata verification failed')
  }
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

async function readExact(handle: FileHandle, length: number, state: ArchiveReadState): Promise<Buffer> {
  if (!Number.isSafeInteger(length) || length < 0 || length > IO_CHUNK_BYTES) {
    throw new Error('Uninstall cleanup archive read exceeds the metadata limit')
  }
  if (length > remainingArchiveBytes(state)) {
    throw new Error('Uninstall cleanup archive is truncated')
  }
  const buffer = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const read = await handle.read(buffer, offset, length - offset, state.position + offset)
    if (read.bytesRead === 0) throw new Error('Uninstall cleanup archive is truncated')
    offset += read.bytesRead
  }
  state.position += length
  return buffer
}

function remainingArchiveBytes(state: ArchiveReadState): number {
  return state.size - state.position
}

async function restoreCanonicalOrThrow(
  archivePath: string,
  productRoot: string,
  transactionId: string,
  maxEntries: number,
  originalError: unknown,
  dependencies: Pick<UninstallCleanupDependencies, 'chmod' | 'utimes'>,
): Promise<void> {
  let lastError: unknown = originalError
  for (let attempt = 1; attempt <= RESTORE_ATTEMPTS; attempt += 1) {
    const restorePath = join(dirname(productRoot), `${RESTORE_PREFIX}${transactionId}-${randomBytes(8).toString('hex')}`)
    let archiveRestored = false
    try {
      await restoreArchive(archivePath, restorePath, transactionId, maxEntries, dependencies)
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

async function recoverInterruptedTransactions(
  appData: string,
  productRoot: string,
  maxEntries: number,
  dependencies: Pick<UninstallCleanupDependencies, 'chmod' | 'utimes'>,
): Promise<void> {
  const transaction = await scanReservedTransaction(appData)
  if (transaction === undefined) return
  if (transaction.archive === undefined) {
    throw new Error('Uninstall cleanup refuses an orphan transaction artifact')
  }
  const verificationPath = join(appData, `${RESTORE_PREFIX}${transaction.id}-${randomBytes(8).toString('hex')}`)
  await restoreArchive(transaction.archive.path, verificationPath, transaction.id, maxEntries, dependencies)
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
