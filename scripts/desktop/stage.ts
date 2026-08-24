/** Assemble and validate a relocatable production deployment for the desktop app. */

import { spawnSync } from 'node:child_process'
import type { Stats } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertOwnedOutput,
  DESKTOP_STAGE,
  REPOSITORY_ROOT,
} from './packaging-layout.ts'

interface DeploymentManifest {
  readonly name: string
  readonly description?: string | undefined
  readonly version: string
  readonly type?: string | undefined
  readonly main: string
  readonly license?: string | undefined
  readonly dependencies: Readonly<Record<string, string>>
}

interface MaterializationFileSystem {
  readonly cp: typeof cp
  readonly lstat: (path: string) => Promise<Stats>
  readonly mkdtemp: typeof mkdtemp
  readonly readlink: typeof readlink
  readonly rename: typeof rename
  readonly rm: typeof rm
  readonly unlink: typeof unlink
}

const nodeMaterializationFileSystem: MaterializationFileSystem = {
  cp,
  lstat,
  mkdtemp,
  readlink,
  rename,
  rm,
  unlink,
}

function strictDescendant(root: string, candidate: string): boolean {
  const descendant = relative(root, candidate)
  return descendant !== ''
    && descendant !== '..'
    && !descendant.startsWith(`..${sep}`)
    && !isAbsolute(descendant)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function requiredString(manifest: Readonly<Record<string, unknown>>, key: string): string {
  const value = manifest[key]
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop staging: source package.json requires a non-empty ${key}`)
  }
  return value
}

function optionalString(manifest: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = manifest[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`desktop staging: source package.json ${key} must be a string`)
  return value
}

function runtimeDependencies(manifest: Readonly<Record<string, unknown>>): Readonly<Record<string, string>> {
  const value = manifest.dependencies
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop staging: source package.json dependencies must be an object')
  }
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== 'string') {
      throw new Error(`desktop staging: source package.json dependency ${name} must use a string range`)
    }
  }
  return value as Readonly<Record<string, string>>
}

/**
 * Select the runtime-only desktop package metadata written into the deployment.
 * @param source - Parsed source desktop package manifest.
 * @returns A manifest containing only relocatable runtime metadata.
 */
export function deploymentManifest(source: Readonly<Record<string, unknown>>): DeploymentManifest {
  return {
    name: requiredString(source, 'name'),
    description: optionalString(source, 'description'),
    version: requiredString(source, 'version'),
    type: optionalString(source, 'type'),
    main: requiredString(source, 'main'),
    license: optionalString(source, 'license'),
    dependencies: runtimeDependencies(source),
  }
}

/**
 * Build a shell-free invocation of the pnpm CLI that launched this command.
 * @param corepackCli - Corepack's JavaScript CLI path.
 * @returns The Node executable and leading pnpm CLI argument.
 */
export function pnpmInvocation(corepackCli: string = join(dirname(process.execPath), 'node_modules/corepack/dist/corepack.js')): {
  readonly command: string
  readonly argsPrefix: readonly string[]
} {
  return { command: process.execPath, argsPrefix: [corepackCli, 'pnpm'] }
}

/**
 * Reject a deployed link whose resolved target escapes the relocatable stage.
 * @param linkPath - Absolute path of the link inside the stage.
 * @param target - Link target returned by the filesystem.
 */
export function assertRelocatableLink(linkPath: string, target: string): void {
  const resolvedTarget = resolve(dirname(linkPath), target)
  const stageRelative = relative(DESKTOP_STAGE, resolvedTarget)
  if (
    stageRelative === '..'
    || stageRelative.startsWith(`..${sep}`)
    || isAbsolute(stageRelative)
  ) {
    throw new Error(`desktop staging: link escapes deployment: ${linkPath} -> ${target}`)
  }
}

/**
 * Resolve a bundle manifest beside the real pnpm installation of dsh.
 * @param packageName - Bundle package name.
 * @param dshManifestPath - Logical or real path to the staged dsh manifest.
 * @returns Absolute path to the resolved bundle manifest.
 */
export async function resolveBundleManifest(
  packageName: string,
  dshManifestPath: string,
  stageRoot: string = DESKTOP_STAGE,
): Promise<string> {
  const realStageRoot = await realpath(stageRoot)
  const realDshManifest = await realpath(dshManifestPath)
  const manifestPath = await realpath(createRequire(realDshManifest).resolve(`${packageName}/package.json`))
  if (!strictDescendant(realStageRoot, manifestPath)) {
    throw new Error(`desktop staging: resolved bundle manifest is outside staged runtime: ${manifestPath}`)
  }
  return manifestPath
}

function assertExactStage(path: string): void {
  assertOwnedOutput(path)
  if (resolve(path) !== resolve(DESKTOP_STAGE)) {
    throw new Error(`desktop staging: refusing to replace unexpected path: ${path}`)
  }
}

async function assertOrdinaryFile(path: string): Promise<void> {
  let stats
  try {
    stats = await lstat(path)
  } catch (error) {
    throw new Error(`desktop staging: required file is missing: ${path}`, { cause: error })
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`desktop staging: required path is not an ordinary file: ${path}`)
  }
}

async function verifyRelocatableLinks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      assertRelocatableLink(entryPath, await readlink(entryPath))
    } else if (entry.isDirectory()) {
      await verifyRelocatableLinks(entryPath)
    }
  }
}

async function escapingLinks(
  directory: string,
  stageRoot: string,
): Promise<Array<{ readonly path: string; readonly target: string }>> {
  const links: Array<{ readonly path: string; readonly target: string }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(entryPath)
      if (!strictDescendant(stageRoot, resolve(dirname(entryPath), target))) {
        links.push({ path: entryPath, target })
      }
    } else if (entry.isDirectory()) {
      links.push(...await escapingLinks(entryPath, stageRoot))
    }
  }
  return links
}

/**
 * Replace allowlisted workspace links with private staged copies.
 * @param stageRoot - Real deployment root containing pnpm's link graph.
 * @param repositoryRoot - Repository containing the allowlisted workspace sources.
 * @param operationOverrides - Filesystem operations supplied by a constrained host.
 */
export async function materializeWorkspaceLinks(
  stageRoot: string,
  repositoryRoot: string,
  operationOverrides: Partial<MaterializationFileSystem> = {},
): Promise<void> {
  const operations: MaterializationFileSystem = { ...nodeMaterializationFileSystem, ...operationOverrides }
  const allowedSources = new Set([
    join(repositoryRoot, 'apps/desktop'),
    join(repositoryRoot, 'native/landlock-run/packages/linux-arm64'),
    join(repositoryRoot, 'native/landlock-run/packages/linux-x64'),
    join(repositoryRoot, 'vendor/cosmokit'),
    join(repositoryRoot, 'vendor/schemastery'),
  ].map(path => resolve(path)))
  for (const link of await escapingLinks(stageRoot, stageRoot)) {
    const source = resolve(dirname(link.path), link.target)
    if (!allowedSources.has(source)) {
      throw new Error(`desktop staging: cannot materialize unexpected external link: ${link.path} -> ${link.target}`)
    }
    const privateParent = await operations.mkdtemp(join(dirname(link.path), '.dsh-materialize-'))
    const materialized = join(privateParent, 'package')
    try {
      await operations.cp(source, materialized, {
        recursive: true,
        filter: path => !['.artifacts', 'node_modules'].includes(path.slice(path.lastIndexOf(sep) + 1)),
      })
      const currentStats = await operations.lstat(link.path)
      const currentTarget = currentStats.isSymbolicLink() ? await operations.readlink(link.path) : undefined
      if (currentTarget !== link.target) {
        throw new Error(`desktop staging: link changed before replacement: ${link.path}`)
      }
      await operations.unlink(link.path)
      await operations.rename(materialized, link.path)
    } finally {
      await operations.rm(privateParent, { recursive: true, force: true })
    }
  }
}

async function validateRealAncestors(repositoryRoot: string, parent: string): Promise<void> {
  const root = resolve(repositoryRoot)
  const destinationParent = resolve(parent)
  if (!strictDescendant(root, destinationParent)) {
    throw new Error(`desktop staging: artifact parent is outside repository: ${destinationParent}`)
  }
  const canonicalRoot = await realpath(root)
  const components = relative(root, destinationParent).split(sep)
  let current = root
  for (const component of ['', ...components]) {
    if (component !== '') current = join(current, component)
    let stats
    try {
      stats = await lstat(current)
    } catch (error) {
      if (isMissing(error)) break
      throw error
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`desktop staging: link-shaped ancestor blocks deletion: ${current}`)
    }
    const canonical = await realpath(current)
    if (canonical !== canonicalRoot && !strictDescendant(canonicalRoot, canonical)) {
      throw new Error(`desktop staging: resolved ancestor escapes repository: ${current} -> ${canonical}`)
    }
  }
}

/**
 * Remove only the validated stage leaf and recreate its real parent directory.
 * @param repositoryRoot - Repository that owns the artifact hierarchy.
 * @param stagePath - Exact stage directory to replace.
 */
export async function resetStageDirectory(repositoryRoot: string, stagePath: string): Promise<void> {
  const stage = resolve(stagePath)
  await validateRealAncestors(repositoryRoot, dirname(stage))
  await mkdir(dirname(stage), { recursive: true })
  await validateRealAncestors(repositoryRoot, dirname(stage))
  let stats
  try {
    stats = await lstat(stage)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  const quarantineParent = await mkdtemp(join(dirname(stage), '.dsh-remove-'))
  const quarantinedStage = join(quarantineParent, 'stage')
  try {
    await rename(stage, quarantinedStage)
    stats = await lstat(quarantinedStage)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      await unlink(quarantinedStage)
    } else {
      await rm(quarantinedStage, { recursive: true })
    }
  } finally {
    await rm(quarantineParent, { recursive: true, force: true })
  }
}

async function verifyRuntime(): Promise<void> {
  const requiredFiles = [
    join(DESKTOP_STAGE, 'lib/main.js'),
    join(DESKTOP_STAGE, 'lib/preload.cjs'),
    join(DESKTOP_STAGE, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]
  const bundlePackages = [
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-desktop-app',
  ]
  for (const path of requiredFiles) await assertOrdinaryFile(path)
  const dshManifestPath = join(DESKTOP_STAGE, 'node_modules/@deepseek-ai/dsh/package.json')
  for (const packageName of bundlePackages) {
    let manifestPath: string
    try {
      manifestPath = await resolveBundleManifest(packageName, dshManifestPath, DESKTOP_STAGE)
    } catch (error) {
      throw new Error(`desktop staging: cannot resolve ${packageName}/package.json from staged @deepseek-ai/dsh`, { cause: error })
    }
    const packageRoot = dirname(manifestPath)
    await assertOrdinaryFile(manifestPath)
    await assertOrdinaryFile(join(packageRoot, 'cordis.patch.yml'))
  }
  await verifyRelocatableLinks(DESKTOP_STAGE)
}

async function main(): Promise<void> {
  assertExactStage(DESKTOP_STAGE)
  await resetStageDirectory(REPOSITORY_ROOT, DESKTOP_STAGE)

  const pnpm = pnpmInvocation()
  const result = spawnSync(
    pnpm.command,
    [...pnpm.argsPrefix, '--filter', '@deepseek-ai/dsh-desktop', 'deploy', '--prod', '--legacy', DESKTOP_STAGE],
    { cwd: REPOSITORY_ROOT, stdio: 'inherit' },
  )
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`desktop staging: pnpm deploy exited with ${String(result.status)}`)

  const sourcePath = join(REPOSITORY_ROOT, 'apps/desktop/package.json')
  const source = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown>
  await writeFile(join(DESKTOP_STAGE, 'package.json'), `${JSON.stringify(deploymentManifest(source), null, 2)}\n`)
  await materializeWorkspaceLinks(DESKTOP_STAGE, REPOSITORY_ROOT)
  await verifyRuntime()
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
