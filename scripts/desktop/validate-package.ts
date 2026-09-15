/** Fail-closed validation for a Windows desktop application's unpacked runtime. */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { verifyReleaseFiles } from './checksum.ts'
import {
  DESKTOP_INSTALLER,
  DESKTOP_INSTALLER_NAME,
  DESKTOP_STAGE,
  DESKTOP_VERSION,
  REPOSITORY_ROOT,
} from './packaging-layout.ts'

const DEFAULT_MAX_TEXT_BYTES = 4 * 1024 * 1024
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/iu
const TEXT_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.config', '.js', '.cjs', '.mjs', '.html', '.css', '.map'])
const REQUIRED_NATIVE_ADDONS = [
  'resources/app/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node',
  'resources/app/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
  'resources/app/node_modules/node-addon-require-builtin-win32-x64-msvc/prebuilt/win32-x64-msvc-napi-v9.node',
  'resources/app/node_modules/node-pty/prebuilds/win32-x64/conpty.node',
  'resources/app/node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
] as const
// Electron owns this root license inventory; it contains no executable configuration and commonly exceeds 20 MiB.
const OVERSIZE_TEXT_EXCEPTIONS = new Set(['LICENSES.chromium.html'])

export interface PackageValidationOptions {
  /** The electron-builder win-unpacked directory. */
  readonly packageRoot: string
  /** Host roots that must not be embedded in shipped text files. */
  readonly forbiddenRoots?: readonly string[]
  /** Maximum bytes read from any selected text manifest or configuration file. */
  readonly maxTextBytes?: number
}

export interface PackageValidationResult {
  readonly files: number
  readonly links: number
  readonly externalLinks: 0
  readonly packages: number
  readonly nativeBinaries: number
  readonly scannedTextFiles: number
}

export interface PackageTreeEntry {
  readonly path: string
  readonly type: 'directory' | 'file' | 'link'
  readonly sha256?: string
  readonly target?: string
}

interface Manifest {
  readonly name: string
  readonly dependencies: Readonly<Record<string, string>>
  readonly peerDependencies: Readonly<Record<string, string>>
  readonly optionalPeers: ReadonlySet<string>
}

function descendantOrSame(root: string, candidate: string): boolean {
  const value = relative(root, candidate)
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value))
}

function display(root: string, path: string): string {
  return relative(root, path).split(sep).join('/') || '.'
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME.test(name) || name === '.' || name === '..') {
    throw new Error('desktop package validation: invalid package name in manifest')
  }
}

function stringMap(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop package validation: ${field} must be an object`)
  }
  const result: Record<string, string> = {}
  for (const [name, range] of Object.entries(value)) {
    assertPackageName(name)
    if (typeof range !== 'string') throw new Error(`desktop package validation: ${field} ranges must be strings`)
    result[name] = range
  }
  return result
}

async function parseManifest(path: string): Promise<Manifest> {
  let parsed: unknown
  try { parsed = JSON.parse(await readFile(path, 'utf8')) } catch (error) {
    throw new Error('desktop package validation: invalid package manifest', { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('desktop package validation: package manifest must be an object')
  }
  const value = parsed as Record<string, unknown>
  if (typeof value.name !== 'string') throw new Error('desktop package validation: package manifest requires name')
  assertPackageName(value.name)
  const metadata = value.peerDependenciesMeta
  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    throw new Error('desktop package validation: peerDependenciesMeta must be an object')
  }
  const optionalPeers = new Set<string>()
  for (const [name, entry] of Object.entries((metadata ?? {}) as Record<string, unknown>)) {
    assertPackageName(name)
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error('desktop package validation: peer dependency metadata must be an object')
    }
    if ((entry as { optional?: unknown }).optional === true) optionalPeers.add(name)
  }
  return {
    name: value.name,
    dependencies: stringMap(value.dependencies, 'dependencies'),
    peerDependencies: stringMap(value.peerDependencies, 'peerDependencies'),
    optionalPeers,
  }
}

async function assertSafeLink(packageRoot: string, linkPath: string): Promise<void> {
  let target: string
  try { target = await readlink(linkPath) } catch (error) {
    throw new Error(`desktop package validation: unreadable link at ${display(packageRoot, linkPath)}`, { cause: error })
  }
  const lexicalTarget = resolve(dirname(linkPath), target)
  if (!descendantOrSame(packageRoot, lexicalTarget)) {
    throw new Error(`desktop package validation: link points outside package at ${display(packageRoot, linkPath)}`)
  }
  let canonicalTarget: string
  try { canonicalTarget = await realpath(lexicalTarget) } catch (error) {
    throw new Error(`desktop package validation: dangling link at ${display(packageRoot, linkPath)}`, { cause: error })
  }
  if (!descendantOrSame(packageRoot, canonicalTarget)) {
    throw new Error(`desktop package validation: link resolves outside package at ${display(packageRoot, linkPath)}`)
  }
  const components = relative(packageRoot, lexicalTarget).split(sep).filter(Boolean)
  let current = packageRoot
  for (const component of components.slice(0, -1)) {
    current = join(current, component)
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`desktop package validation: link target crosses a reparse chain at ${display(packageRoot, linkPath)}`)
    }
  }
}

async function walkWithoutFollowingLinks(root: string): Promise<{ readonly files: string[]; readonly links: number }> {
  const files: string[] = []
  let links = 0
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const status = await lstat(path)
      if (status.isSymbolicLink()) {
        links += 1
        await assertSafeLink(root, path)
      } else if (status.isDirectory()) {
        await visit(path)
      } else if (status.isFile()) {
        files.push(path)
      } else {
        throw new Error(`desktop package validation: unsupported filesystem entry at ${display(root, path)}`)
      }
    }
  }
  await visit(root)
  return { files, links }
}

async function assertOrdinaryFile(root: string, path: string, purpose: string): Promise<void> {
  let status
  try { status = await lstat(path) } catch (error) {
    throw new Error(`desktop package validation: required ${purpose} file is missing`, { cause: error })
  }
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`desktop package validation: required ${purpose} is not an ordinary file at ${display(root, path)}`)
  }
}

async function resolveDependency(appRoot: string, consumerRoot: string, name: string): Promise<string | undefined> {
  assertPackageName(name)
  let current = consumerRoot
  for (;;) {
    const candidate = join(current, 'node_modules', ...name.split('/'))
    if (descendantOrSame(appRoot, candidate)) {
      try {
        const status = await lstat(candidate)
        if (status.isSymbolicLink()) await assertSafeLink(appRoot, candidate)
        else if (!status.isDirectory()) throw new Error('desktop package validation: dependency path is not a directory')
        const canonical = await realpath(candidate)
        if (!descendantOrSame(appRoot, canonical)) throw new Error('desktop package validation: dependency resolves outside app')
        await assertOrdinaryFile(appRoot, join(canonical, 'package.json'), 'dependency manifest')
        return canonical
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      }
    }
    if (current === appRoot) return undefined
    const parent = dirname(current)
    if (!descendantOrSame(appRoot, parent) || parent === current) return undefined
    current = parent
  }
}

async function productionGraph(appRoot: string): Promise<Map<string, { readonly root: string; readonly manifest: Manifest }>> {
  const graph = new Map<string, { readonly root: string; readonly manifest: Manifest }>()
  const queue = [appRoot]
  while (queue.length > 0) {
    const root = queue.shift() as string
    const canonical = await realpath(root)
    if (graph.has(canonical)) continue
    const manifest = await parseManifest(join(canonical, 'package.json'))
    graph.set(canonical, { root: canonical, manifest })
    for (const name of Object.keys(manifest.dependencies)) {
      const dependency = await resolveDependency(appRoot, canonical, name)
      if (dependency === undefined) throw new Error(`desktop package validation: missing production dependency ${name}`)
      queue.push(dependency)
    }
  }
  for (const { root, manifest } of graph.values()) {
    for (const name of Object.keys(manifest.peerDependencies)) {
      if (manifest.optionalPeers.has(name)) continue
      if (await resolveDependency(appRoot, root, name) === undefined) {
        throw new Error(`desktop package validation: missing required peer dependency ${name}`)
      }
    }
  }
  return graph
}

async function assertX64Pe(path: string): Promise<void> {
  const fileSize = (await lstat(path)).size
  const handle = await import('node:fs/promises').then(module => module.open(path, 'r'))
  try {
    const header = Buffer.alloc(64)
    const first = await handle.read(header, 0, header.length, 0)
    if (first.bytesRead < 64 || header.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('desktop package validation: malformed PE binary')
    }
    const offset = header.readUInt32LE(0x3c)
    if (offset < 64 || offset > 16 * 1024 * 1024) throw new Error('desktop package validation: malformed PE header offset')
    if (offset + 24 > fileSize) throw new Error('desktop package validation: truncated PE COFF header')
    const coff = Buffer.alloc(24)
    const second = await handle.read(coff, 0, coff.length, offset)
    if (second.bytesRead !== coff.length || coff.toString('binary', 0, 4) !== 'PE\0\0') {
      throw new Error('desktop package validation: malformed PE signature')
    }
    if (coff.readUInt16LE(4) !== 0x8664) throw new Error('desktop package validation: PE binary is not x64')
    const sectionCount = coff.readUInt16LE(6)
    if (sectionCount === 0 || sectionCount > 96) throw new Error('desktop package validation: invalid PE COFF section count')
    const optionalLength = coff.readUInt16LE(20)
    if (optionalLength < 112 || optionalLength > 4096) {
      throw new Error('desktop package validation: invalid PE optional header length')
    }
    const optionalOffset = offset + 24
    const sectionTableOffset = optionalOffset + optionalLength
    const sectionTableEnd = sectionTableOffset + sectionCount * 40
    if (sectionTableEnd > fileSize) throw new Error('desktop package validation: truncated PE section table')
    const optional = Buffer.alloc(optionalLength)
    if ((await handle.read(optional, 0, optional.length, optionalOffset)).bytesRead !== optional.length) {
      throw new Error('desktop package validation: truncated PE optional header')
    }
    if (optional.readUInt16LE(0) !== 0x20b) throw new Error('desktop package validation: PE optional header is not PE32+')
    const directoryCount = optional.readUInt32LE(108)
    if (directoryCount > 16 || 112 + directoryCount * 8 > optionalLength) {
      throw new Error('desktop package validation: PE data directory table is out of bounds')
    }
    const sizeOfHeaders = optional.readUInt32LE(60)
    if (sizeOfHeaders < sectionTableEnd || sizeOfHeaders > fileSize) {
      throw new Error('desktop package validation: PE header size is out of bounds')
    }
    const sections = Buffer.alloc(sectionCount * 40)
    if ((await handle.read(sections, 0, sections.length, sectionTableOffset)).bytesRead !== sections.length) {
      throw new Error('desktop package validation: truncated PE section table')
    }
    for (let index = 0; index < sectionCount; index += 1) {
      const base = index * 40
      const rawSize = sections.readUInt32LE(base + 16)
      const rawOffset = sections.readUInt32LE(base + 20)
      if (rawSize > 0 && (rawOffset < sizeOfHeaders || rawOffset + rawSize > fileSize)) {
        throw new Error('desktop package validation: PE section data is out of bounds')
      }
    }
  } finally {
    await handle.close()
  }
}

function normalizedPublishedText(value: string): string {
  return value.toLowerCase().replaceAll('\\', '/').replace(/\/{2,}/gu, '/').replace(/\/+$/u, '')
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Hash every ordinary file and record every directory and link in deterministic path order.
 * @param root - Canonical package root to inventory without following links.
 * @returns Complete package tree records sorted by relative path.
 */
export async function packageTreeManifest(root: string): Promise<readonly PackageTreeEntry[]> {
  const packageRoot = resolve(root)
  const records: PackageTreeEntry[] = []
  async function visit(directory: string): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name)
      const relativePath = display(packageRoot, path)
      const status = await lstat(path)
      if (status.isSymbolicLink()) {
        records.push({ path: relativePath, type: 'link', target: await readlink(path) })
      } else if (status.isDirectory()) {
        records.push({ path: relativePath, type: 'directory' })
        await visit(path)
      } else if (status.isFile()) {
        records.push({ path: relativePath, type: 'file', sha256: await sha256File(path) })
      } else {
        throw new Error(`desktop package validation: unsupported filesystem entry at ${relativePath}`)
      }
    }
  }
  await visit(packageRoot)
  return records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

const FOREIGN_PREBUILD_PLATFORMS = new Set(['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-arm64'])
const WINDOWS_X64_PREBUILD_PLATFORMS = new Set(['win32-x64'])

/**
 * Remove only native binaries in known foreign-platform dependency directories.
 * @param root - Staged application root whose ordinary directories are inspected without following links.
 * @returns Number of foreign native binary files removed.
 */
export async function pruneForeignNativePayloads(root: string): Promise<number> {
  const deploymentRoot = resolve(root)
  let removed = 0
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const status = await lstat(path)
      if (status.isSymbolicLink()) continue
      if (status.isDirectory()) {
        await visit(path)
        continue
      }
      if (!status.isFile() || !['.exe', '.node'].includes(extname(name).toLowerCase())) continue
      const segments = relative(deploymentRoot, path).split(sep).map(segment => segment.toLowerCase())
      const prebuilds = segments.lastIndexOf('prebuilds')
      if (prebuilds >= 0) {
        const platform = segments[prebuilds + 1]
        if (platform === undefined || (!FOREIGN_PREBUILD_PLATFORMS.has(platform) && !WINDOWS_X64_PREBUILD_PLATFORMS.has(platform))) {
          throw new Error('desktop package validation: unknown native platform under prebuilds')
        }
        if (FOREIGN_PREBUILD_PLATFORMS.has(platform)) {
          await unlink(path)
          removed += 1
        }
        continue
      }
      const conpty = segments.lastIndexOf('conpty')
      const thirdParty = segments.lastIndexOf('third_party')
      if (thirdParty >= 0 && conpty > thirdParty) {
        const platform = segments.find((segment, index) => index > conpty && /^win10-/u.test(segment))
        if (platform !== undefined && platform !== 'win10-x64' && platform !== 'win10-arm64') {
          throw new Error('desktop package validation: unknown native platform under conpty')
        }
        if (platform === 'win10-arm64') {
          await unlink(path)
          removed += 1
        }
      }
    }
  }
  await visit(deploymentRoot)
  return removed
}

/**
 * Remove Rolldown region comments that persist absolute CSS module source paths.
 * @param root - Unpacked application root inspected without following links.
 * @returns Number of generated source-location comments removed.
 */
export async function sanitizeBundlerRegionMarkers(root: string): Promise<number> {
  const deploymentRoot = resolve(root)
  let removed = 0
  async function visit(directory: string): Promise<void> {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const status = await lstat(path)
      if (status.isSymbolicLink()) continue
      if (status.isDirectory()) {
        await visit(path)
        continue
      }
      if (!status.isFile() || !['.js', '.cjs', '.mjs'].includes(extname(name).toLowerCase())) continue
      if (status.size > DEFAULT_MAX_TEXT_BYTES) {
        throw new Error('desktop package validation: generated JavaScript exceeds sanitization size cap')
      }
      const source = await readFile(path, 'utf8')
      const sanitized = source.replace(/^(?:[ \t]|\\[tr])*\/\/#region \\0[^\r\n]*(?:\r?\n|$)/gmu, () => {
        removed += 1
        return ''
      })
      if (sanitized !== source) await writeFile(path, sanitized, 'utf8')
    }
  }
  await visit(deploymentRoot)
  return removed
}

/**
 * Validate one electron-builder unpacked application without loading shipped code.
 * @param options - Package root, forbidden host roots, and bounded text read limit.
 * @returns Counts describing the validated runtime closure.
 */
export async function validatePackage(options: PackageValidationOptions): Promise<PackageValidationResult> {
  const packageRoot = resolve(options.packageRoot)
  const rootStatus = await lstat(packageRoot)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw new Error('desktop package validation: package root must be an ordinary directory')
  }
  const canonicalRoot = await realpath(packageRoot)
  if (canonicalRoot !== packageRoot) throw new Error('desktop package validation: package root must use its canonical path')
  const appRoot = join(packageRoot, 'resources', 'app')
  const requiredFiles = [
    [join(appRoot, 'lib', 'main.js'), 'desktop main'],
    [join(appRoot, 'lib', 'preload.cjs'), 'desktop preload'],
    [join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'CLI'],
    [join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-base', 'cordis.patch.yml'), 'base profile'],
    [join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app', 'cordis.patch.yml'), 'web profile'],
    [join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-app', 'cordis.patch.yml'), 'desktop profile'],
    [join(appRoot, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'index.html'), 'web frontend'],
  ] as const
  for (const [path, purpose] of requiredFiles) await assertOrdinaryFile(packageRoot, path, purpose)
  for (const relativePath of REQUIRED_NATIVE_ADDONS) {
    await assertOrdinaryFile(packageRoot, join(packageRoot, ...relativePath.split('/')), 'native addon')
  }

  const discovery = await walkWithoutFollowingLinks(packageRoot)
  const graph = await productionGraph(appRoot)
  const executable = join(packageRoot, 'DeepSeek Harness.exe')
  await assertOrdinaryFile(packageRoot, executable, 'main executable')
  await assertX64Pe(executable)
  let nativeBinaries = 1
  for (const path of discovery.files) {
    if (path !== executable && ['.exe', '.node'].includes(extname(path).toLowerCase())) {
      await assertX64Pe(path)
      nativeBinaries += 1
    }
  }
  const forbidden = (options.forbiddenRoots ?? [
    REPOSITORY_ROOT,
    homedir(),
    DESKTOP_STAGE,
    join(parse(REPOSITORY_ROOT).root, '.pnpm-store'),
  ])
    .map(normalizedPublishedText)
    .filter(value => value.length >= 4)
  const maxTextBytes = options.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes <= 0) {
    throw new Error('desktop package validation: maxTextBytes must be a positive safe integer')
  }
  let scannedTextFiles = 0
  for (const path of discovery.files) {
    if (!TEXT_EXTENSIONS.has(extname(path).toLowerCase())) continue
    const status = await lstat(path)
    if (status.size > maxTextBytes) {
      if (OVERSIZE_TEXT_EXCEPTIONS.has(display(packageRoot, path))) continue
      throw new Error(`desktop package validation: text size cap exceeded at ${display(packageRoot, path)}`)
    }
    const content = normalizedPublishedText(await readFile(path, 'utf8'))
    if (forbidden.some(root => content.includes(root))) {
      throw new Error(`desktop package validation: absolute build path found at ${display(packageRoot, path)}`)
    }
    scannedTextFiles += 1
  }
  return {
    files: discovery.files.length,
    links: discovery.links,
    externalLinks: 0,
    packages: graph.size,
    nativeBinaries,
    scannedTextFiles,
  }
}

async function main(): Promise<void> {
  const packageRoot = resolve(process.argv[2] ?? join(DESKTOP_INSTALLER, 'win-unpacked'))
  const result = await validatePackage({ packageRoot })
  const release = await verifyReleaseFiles({
    outputRoot: DESKTOP_INSTALLER,
    artifact: join(DESKTOP_INSTALLER, DESKTOP_INSTALLER_NAME),
    expectedVersion: DESKTOP_VERSION,
  })
  console.log(JSON.stringify({ ...result, release }))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try { await main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
