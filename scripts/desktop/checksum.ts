/** Atomic checksum and release-metadata files for the Windows installer. */

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
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
  readonly expectedVersion?: string
  /** Test seam for hosts without Windows Authenticode. Production callers omit it. */
  readonly actualSignature?: SignatureMetadata
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

/** Return the fixed PowerShell program used for Authenticode status inspection. */
export function authenticodePowerShellCommand(): string {
  return [
    '$value = Get-AuthenticodeSignature -LiteralPath $env:DSH_SIGNATURE_ARTIFACT',
    '[Console]::Out.Write(($value.Status.ToString()))',
  ].join('; ')
}

/** Build the Authenticode child environment with only Windows PowerShell module roots. */
export function authenticodeEnvironment(path: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const systemRoot = environment.SystemRoot
  const programFiles = environment.ProgramFiles
  if (systemRoot === undefined || programFiles === undefined) {
    throw new Error('desktop release: Windows module roots are unavailable')
  }
  return {
    SystemRoot: systemRoot,
    WINDIR: environment.WINDIR ?? systemRoot,
    ProgramFiles: programFiles,
    DSH_SIGNATURE_ARTIFACT: path,
    PSModulePath: [
      join(systemRoot, 'system32/WindowsPowerShell/v1.0/Modules'),
      join(programFiles, 'WindowsPowerShell/Modules'),
    ].join(';'),
  }
}

/** Resolve the absolute inbox Windows PowerShell executable. */
export function authenticodePowerShellPath(environment: NodeJS.ProcessEnv): string {
  const systemRoot = environment.SystemRoot
  if (systemRoot === undefined) throw new Error('desktop release: Windows system root is unavailable')
  return join(systemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
}

/** Return bounded spawn options with a credential-free child environment. */
export function authenticodeSpawnOptions(path: string, environment: NodeJS.ProcessEnv) {
  return {
    cwd: dirname(path),
    encoding: 'utf8' as const,
    env: authenticodeEnvironment(path, environment),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  }
}

function readExact(file: number, length: number, position: number): Buffer {
  const value = Buffer.alloc(length)
  if (readSync(file, value, 0, length, position) !== length) {
    throw new Error('desktop release: portable executable header is truncated')
  }
  return value
}

/** Report whether a PE file declares an embedded Authenticode certificate table. */
export function hasAuthenticodeCertificate(path: string): boolean {
  const file = openSync(path, 'r')
  try {
    const size = fstatSync(file).size
    if (size < 64) throw new Error('desktop release: portable executable header is truncated')
    const dos = readExact(file, 64, 0)
    if (dos.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('desktop release: artifact is not a portable executable')
    }
    const peOffset = dos.readUInt32LE(0x3c)
    if (peOffset > size - 24) throw new Error('desktop release: portable executable header is invalid')
    const pe = readExact(file, 24, peOffset)
    if (pe.toString('binary', 0, 4) !== 'PE\0\0') {
      throw new Error('desktop release: artifact is not a portable executable')
    }
    const optionalSize = pe.readUInt16LE(20)
    const optionalOffset = peOffset + 24
    if (optionalSize < 2 || optionalSize > size - optionalOffset) {
      throw new Error('desktop release: portable executable optional header is truncated')
    }
    const optional = readExact(file, optionalSize, optionalOffset)
    const magic = optional.readUInt16LE(0)
    const directoryOffset = magic === 0x10b ? 96 : magic === 0x20b ? 112 : undefined
    if (directoryOffset === undefined) {
      throw new Error('desktop release: portable executable optional header is invalid')
    }
    const directoryCountOffset = directoryOffset - 4
    const certificateEntryOffset = directoryOffset + (4 * 8)
    if (optionalSize < certificateEntryOffset + 8 || optional.readUInt32LE(directoryCountOffset) < 5) {
      throw new Error('desktop release: portable executable certificate directory is absent')
    }
    const certificateOffset = optional.readUInt32LE(certificateEntryOffset)
    const certificateSize = optional.readUInt32LE(certificateEntryOffset + 4)
    if (certificateOffset === 0 && certificateSize === 0) return false
    if (
      certificateOffset === 0
      || certificateSize === 0
      || certificateOffset > size
      || certificateSize > size - certificateOffset
    ) {
      throw new Error('desktop release: portable executable certificate table is invalid')
    }
    return true
  } finally {
    closeSync(file)
  }
}

/** Read the real Windows Authenticode state of an artifact. */
export function inspectAuthenticode(path: string): SignatureMetadata {
  if (!hasAuthenticodeCertificate(path)) return { signed: false, signatureStatus: 'NotSigned' }
  const result = spawnSync(authenticodePowerShellPath(process.env), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', authenticodePowerShellCommand(),
  ], authenticodeSpawnOptions(path, process.env))
  if (result.error !== undefined || result.status !== 0) {
    throw new Error('desktop release: Authenticode inspection failed', { cause: result.error })
  }
  const signatureStatus = result.stdout.trim()
  if (signatureStatus !== 'Valid' && signatureStatus !== 'NotSigned') {
    throw new Error('desktop release: Authenticode status is not releasable')
  }
  return { signed: signatureStatus === 'Valid', signatureStatus }
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
  for (const sidecar of [metadataPath, `${paths.artifact}.sha256`]) {
    const sidecarStatus = await lstat(sidecar)
    if (!sidecarStatus.isFile() || sidecarStatus.isSymbolicLink()) {
      throw new Error('desktop release: sidecar must be an ordinary file')
    }
  }
  const parsedValue = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown
  if (typeof parsedValue !== 'object' || parsedValue === null || Array.isArray(parsedValue)) {
    throw new Error('desktop release: metadata must be an object')
  }
  const parsed = parsedValue as Partial<ReleaseMetadata>
  const fields = ['arch', 'artifact', 'bytes', 'sha256', 'signatureStatus', 'signed', 'version']
  if (Object.keys(parsed).sort().join('\0') !== fields.join('\0')) {
    throw new Error('desktop release: metadata fields are not exact')
  }
  const digest = await sha256(paths.artifact)
  const bytes = (await stat(paths.artifact)).size
  const expectedLine = `${digest}  ${basename(paths.artifact)}\n`
  if (await readFile(`${paths.artifact}.sha256`, 'utf8') !== expectedLine) {
    throw new Error('desktop release: checksum sidecar does not match artifact')
  }
  const expectedFilename = typeof parsed.version === 'string'
    ? `DeepSeek-Harness-Setup-${parsed.version}-x64.exe`
    : ''
  const actualSignature = options.actualSignature ?? inspectAuthenticode(paths.artifact)
  if (
    parsed.artifact !== basename(paths.artifact)
    || parsed.artifact !== expectedFilename
    || parsed.sha256 !== digest
    || parsed.bytes !== bytes
    || parsed.arch !== 'x64'
    || typeof parsed.version !== 'string'
    || (options.expectedVersion !== undefined && parsed.version !== options.expectedVersion)
    || typeof parsed.signed !== 'boolean'
    || typeof parsed.signatureStatus !== 'string'
    || (parsed.signatureStatus !== 'Valid' && parsed.signatureStatus !== 'NotSigned')
    || parsed.signed !== (parsed.signatureStatus === 'Valid')
    || parsed.signed !== actualSignature.signed
    || parsed.signatureStatus !== actualSignature.signatureStatus
  ) {
    throw new Error('desktop release: metadata version, artifact, or signature does not match')
  }
  return parsed as ReleaseMetadata
}
