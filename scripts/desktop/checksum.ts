/** Atomic checksum and release-metadata files for the Windows installer. */

import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, realpath, rename, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export interface SignatureMetadata {
  readonly signed: boolean
  readonly signatureStatus: string
}

interface CreateReleaseFilesOptions {
  readonly outputRoot: string
  readonly artifact: string
  readonly version: string
  readonly arch: 'x64'
  readonly signature: SignatureMetadata
}

interface VerifyReleaseFilesOptions {
  readonly outputRoot: string
  readonly artifact: string
}

export interface ReleaseMetadata extends SignatureMetadata {
  readonly version: string
  readonly arch: 'x64'
  readonly artifact: string
  readonly bytes: number
  readonly sha256: string
}

function descendant(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value)
}

async function assertReleasePaths(outputRoot: string, artifact: string): Promise<{ root: string; artifact: string }> {
  const root = resolve(outputRoot)
  const candidate = resolve(artifact)
  const rootStatus = await lstat(root)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink() || await realpath(root) !== root) {
    throw new Error('desktop release: output root must be a canonical ordinary directory')
  }
  if (!descendant(root, candidate) || dirname(candidate) !== root) {
    throw new Error('desktop release: artifact is outside the exact output root')
  }
  const artifactStatus = await lstat(candidate)
  if (!artifactStatus.isFile() || artifactStatus.isSymbolicLink()) {
    throw new Error('desktop release: artifact must be an ordinary file')
  }
  return { root, artifact: candidate }
}

async function sha256(path: string): Promise<string> {
  const value = await readFile(path)
  return createHash('sha256').update(value).digest('hex')
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try { await rename(temporary, path) } catch (error) {
    try { await import('node:fs/promises').then(module => module.unlink(temporary)) } catch {
      // The failed atomic rename may already have consumed the private temporary file.
    }
    throw error
  }
}

/**
 * Write checksum and JSON release metadata beside an installer.
 * @param options - Exact output ownership, release identity, and verified signature state.
 * @returns The metadata written to disk.
 */
export async function createReleaseFiles(options: CreateReleaseFilesOptions): Promise<ReleaseMetadata> {
  const paths = await assertReleasePaths(options.outputRoot, options.artifact)
  const artifactStatus = await stat(paths.artifact)
  const digest = await sha256(paths.artifact)
  const metadata: ReleaseMetadata = {
    version: options.version,
    arch: options.arch,
    artifact: basename(paths.artifact),
    bytes: artifactStatus.size,
    sha256: digest,
    signed: options.signature.signed,
    signatureStatus: options.signature.signatureStatus,
  }
  await atomicWrite(`${paths.artifact}.sha256`, `${digest}  ${metadata.artifact}\n`)
  await atomicWrite(join(paths.root, 'release-metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  return metadata
}

/**
 * Recompute and verify release sidecars for an existing installer.
 * @param options - Exact release root and installer file.
 * @returns The validated release metadata.
 */
export async function verifyReleaseFiles(options: VerifyReleaseFilesOptions): Promise<ReleaseMetadata> {
  const paths = await assertReleasePaths(options.outputRoot, options.artifact)
  const metadataPath = join(paths.root, 'release-metadata.json')
  const parsed = JSON.parse(await readFile(metadataPath, 'utf8')) as Partial<ReleaseMetadata>
  const digest = await sha256(paths.artifact)
  const bytes = (await stat(paths.artifact)).size
  const expectedLine = `${digest}  ${basename(paths.artifact)}\n`
  if (await readFile(`${paths.artifact}.sha256`, 'utf8') !== expectedLine) {
    throw new Error('desktop release: checksum sidecar does not match artifact')
  }
  if (
    parsed.artifact !== basename(paths.artifact)
    || parsed.sha256 !== digest
    || parsed.bytes !== bytes
    || parsed.arch !== 'x64'
    || typeof parsed.version !== 'string'
    || typeof parsed.signed !== 'boolean'
    || typeof parsed.signatureStatus !== 'string'
  ) {
    throw new Error('desktop release: metadata does not match artifact')
  }
  return parsed as ReleaseMetadata
}
