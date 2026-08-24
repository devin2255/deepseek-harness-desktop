/** Assemble and validate a relocatable production deployment for the desktop app. */

import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertOwnedOutput,
  DESKTOP_ARTIFACT_ROOT,
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
export async function resolveBundleManifest(packageName: string, dshManifestPath: string): Promise<string> {
  const realDshManifest = await realpath(dshManifestPath)
  return createRequire(realDshManifest).resolve(`${packageName}/package.json`)
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

async function escapingLinks(directory: string): Promise<Array<{ readonly path: string; readonly target: string }>> {
  const links: Array<{ readonly path: string; readonly target: string }> = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const target = await readlink(entryPath)
      try {
        assertRelocatableLink(entryPath, target)
      } catch {
        links.push({ path: entryPath, target })
      }
    } else if (entry.isDirectory()) {
      links.push(...await escapingLinks(entryPath))
    }
  }
  return links
}

async function materializeWorkspaceLinks(): Promise<void> {
  const allowedSources = new Set([
    join(REPOSITORY_ROOT, 'apps/desktop'),
    join(REPOSITORY_ROOT, 'native/landlock-run/packages/linux-arm64'),
    join(REPOSITORY_ROOT, 'native/landlock-run/packages/linux-x64'),
    join(REPOSITORY_ROOT, 'vendor/cosmokit'),
    join(REPOSITORY_ROOT, 'vendor/schemastery'),
  ].map(path => resolve(path)))
  for (const link of await escapingLinks(DESKTOP_STAGE)) {
    const source = resolve(dirname(link.path), link.target)
    if (!allowedSources.has(source)) {
      throw new Error(`desktop staging: cannot materialize unexpected external link: ${link.path} -> ${link.target}`)
    }
    await rm(link.path, { recursive: true, force: true })
    await cp(source, link.path, {
      recursive: true,
      filter: path => !['.artifacts', 'node_modules'].includes(path.slice(path.lastIndexOf(sep) + 1)),
    })
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
      manifestPath = await resolveBundleManifest(packageName, dshManifestPath)
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
  await mkdir(DESKTOP_ARTIFACT_ROOT, { recursive: true })
  await rm(DESKTOP_STAGE, { recursive: true, force: true })

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
  await materializeWorkspaceLinks()
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
