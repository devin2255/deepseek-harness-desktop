/**
 * Verify that the executable deploy manifest supplies every configured plugin
 * and required workspace peer. With auto peer installation disabled, either
 * omission can otherwise fail only when Cordis loads the packaged plugin.
 */
import { globSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import * as yaml from 'js-yaml'

interface PackageManifest {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
}

interface WorkspacePackage {
  path: string
  manifest: PackageManifest
}

const root = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    manifest: { type: 'string' },
    config: { type: 'string', multiple: true },
  },
})
const runtimeManifestPath = resolve(root, values.manifest ?? 'python/sdk-runtime/package.json')
const runtimeManifest = await loadManifest(runtimeManifestPath)
const runtimeName = runtimeManifest.name ?? 'python/sdk-runtime'
const workspace = await loadWorkspacePackages()
const runtimeDependencies = runtimeManifest.dependencies ?? {}
const runtimeConfigPaths = values.config ?? (values.manifest === undefined
  ? [
    'python/sdk-runtime/src/deepseek_harness_runtime/runtime/cordis.yml',
    'examples/jsonrpc-agent/cordis.yml',
    'examples/jsonrpc-agent/minimal.cordis.yml',
  ]
  : [])
const parents = new Map<string, string | undefined>()
const queue: string[] = []

for (const dependency of Object.keys(runtimeDependencies).sort()) {
  if (!workspace.has(dependency)) continue
  parents.set(dependency, undefined)
  queue.push(dependency)
}

const failures: string[] = []
for (const configPath of runtimeConfigPaths) {
  for (const packageName of await configuredWorkspacePackages(configPath, workspace)) {
    if (runtimeDependencies[packageName]?.startsWith('workspace:') === true) continue
    failures.push(`${configPath} -> ${packageName}`)
  }
}
for (let index = 0; index < queue.length; index += 1) {
  const packageName = queue[index]
  if (packageName === undefined) continue
  const current = workspace.get(packageName)
  if (current === undefined) continue
  const peers = current.manifest.peerDependencies ?? {}
  const peerMeta = current.manifest.peerDependenciesMeta ?? {}
  for (const peer of Object.keys(peers).sort()) {
    if (!workspace.has(peer) || peerMeta[peer]?.optional === true) continue
    if (runtimeDependencies[peer]?.startsWith('workspace:') === true) continue
    failures.push(`${formatChain(runtimeName, packageName, parents)} -> ${peer}`)
  }
  const dependencies = {
    ...current.manifest.dependencies,
    ...current.manifest.optionalDependencies,
  }
  for (const dependency of Object.keys(dependencies).sort()) {
    if (!workspace.has(dependency) || parents.has(dependency)) continue
    parents.set(dependency, packageName)
    queue.push(dependency)
  }
}

if (failures.length > 0) {
  console.error(`verify-runtime-closure: required workspace packages are missing from ${runtimeName} dependencies:`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-runtime-closure: ${queue.length} workspace packages form a closed runtime dependency graph.`)

async function loadWorkspacePackages(): Promise<Map<string, WorkspacePackage>> {
  const paths = globSync(['packages/*/*/package.json', 'vendor/*/package.json'], { cwd: root })
    .sort()
    .map(relative => resolve(root, relative))
  const result = new Map<string, WorkspacePackage>()
  for (const path of paths) {
    const manifest = await loadManifest(path)
    if (manifest.name !== undefined) result.set(manifest.name, { path, manifest })
  }
  return result
}

async function loadManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

async function configuredWorkspacePackages(
  configPath: string,
  workspace: ReadonlyMap<string, WorkspacePackage>,
): Promise<string[]> {
  const expression = new yaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    construct: data => data,
  })
  const document: unknown = yaml.load(await readFile(resolve(root, configPath), 'utf8'), {
    schema: yaml.JSON_SCHEMA.extend(expression),
  })
  const packages = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string' && workspace.has(record.name)) packages.add(record.name)
    for (const child of Object.values(record)) visit(child)
  }
  visit(document)
  return [...packages].sort()
}

function formatChain(
  runtimeName: string,
  packageName: string,
  parents: ReadonlyMap<string, string | undefined>,
): string {
  const chain = [packageName]
  let parent = parents.get(packageName)
  while (parent !== undefined) {
    chain.unshift(parent)
    parent = parents.get(parent)
  }
  return [runtimeName, ...chain].join(' -> ')
}
