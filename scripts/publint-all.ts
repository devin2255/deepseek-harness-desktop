/** Run publint over the exact manifest-declared publication view of every package. */

import {
  globSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { availableParallelism } from 'node:os'
import { dirname, posix, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { publint, type Message, type PackFile } from 'publint'
import { formatMessage } from 'publint/utils'
import ts from 'typescript'

const CONCURRENCY_ENV = 'DSH_PUBLINT_CONCURRENCY'
const repositoryRoot = resolve(import.meta.dirname, '..')
const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: { 'packages-root': { type: 'string' } },
})
const packagesRoot = resolve(options['packages-root'] ?? repositoryRoot)

interface PackageTarget {
  path: string
  directory: string
  manifest: PackageManifest
}

interface PackageManifest {
  name?: string
  files?: unknown
}

type PublintResult =
  | { path: string; status: 'passed'; messages: Message[]; manifest: Record<string, unknown> }
  | { path: string; status: 'failed'; messages: Message[]; manifest: Record<string, unknown>; failure?: string }

function workspacePackages(): PackageTarget[] {
  return globSync('packages/*/*/package.json', { cwd: packagesRoot })
    .sort()
    .map((manifestPath) => {
      const absoluteManifestPath = resolve(packagesRoot, manifestPath)
      const manifest = JSON.parse(readFileSync(absoluteManifestPath, 'utf8')) as PackageManifest
      return { path: dirname(manifestPath), directory: dirname(absoluteManifestPath), manifest }
    })
}

function publintConcurrency(total: number): number {
  if (total === 0) return 0

  const raw = process.env[CONCURRENCY_ENV]
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
      throw new Error(`publint-all: ${CONCURRENCY_ENV} must be a positive integer, got ${JSON.stringify(raw)}.`)
    }
    return Math.min(total, parsed)
  }

  return Math.min(total, availableParallelism())
}

function publicationFiles(target: PackageTarget): PackFile[] {
  const paths = new Set<string>()
  addPath(resolve(target.directory, 'package.json'), paths)
  const declared = Array.isArray(target.manifest.files)
    ? target.manifest.files.filter((value): value is string => typeof value === 'string')
    : []
  for (const pattern of [
    ...declared,
    'README*',
    'LICENSE*',
    'LICENCE*',
    'CHANGELOG*',
    'CHANGES*',
    'HISTORY*',
    'NOTICE*',
  ]) {
    for (const match of globSync(pattern, { cwd: target.directory })) {
      addPath(resolve(target.directory, match), paths)
    }
  }

  return [...paths]
    .sort()
    .map(path => ({
      name: `package/${relative(target.directory, path).split(sep).join('/')}`,
      data: readFileSync(path),
    }))
}

function addPath(path: string, paths: Set<string>): void {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    // readdirSync, not globSync: `**/*` skips dot-prefixed segments, but npm
    // pack publishes dotfiles inside included directories, and this view must
    // match what npm publishes.
    for (const entry of readdirSync(path, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) paths.add(resolve(entry.parentPath, entry.name))
    }
  } else if (stat.isFile()) {
    paths.add(path)
  }
}

function missingRelativeImports(files: readonly PackFile[]): string[] {
  const published = new Set(files.map(file => file.name))
  const missing: string[] = []
  for (const file of files) {
    if (!/\.(?:cjs|js|mjs)$/.test(file.name)) continue
    const source = typeof file.data === 'string' ? file.data : new TextDecoder().decode(file.data)
    const imports = ts.preProcessFile(source, true, true).importedFiles
    for (const imported of imports) {
      if (!imported.fileName.startsWith('.')) continue
      const base = posix.normalize(posix.join(posix.dirname(file.name), imported.fileName))
      const candidates = posix.extname(base) === ''
        ? [base, `${base}.cjs`, `${base}.js`, `${base}.mjs`, `${base}/index.cjs`, `${base}/index.js`, `${base}/index.mjs`]
        : [base]
      if (candidates.some(candidate => published.has(candidate))) continue
      missing.push(`${file.name.slice('package/'.length)} -> ${imported.fileName}`)
    }
  }
  return missing.sort()
}

async function runPublint(target: PackageTarget): Promise<PublintResult> {
  try {
    const files = publicationFiles(target)
    const missing = missingRelativeImports(files)
    const result = await publint({
      pkgDir: 'package',
      pack: { files },
    })
    const manifest = result.pkg as Record<string, unknown>
    const hasPublintError = result.messages.some(message => message.type === 'error')
    if (missing.length === 0 && !hasPublintError) {
      return { path: target.path, status: 'passed', messages: result.messages, manifest }
    }
    const failure = missing.length > 0
      ? `Published JavaScript references files omitted by package.json files:\n${missing.join('\n')}`
      : undefined
    return {
      path: target.path,
      status: 'failed',
      messages: result.messages,
      manifest,
      ...(failure === undefined ? {} : { failure }),
    }
  } catch (error: unknown) {
    return {
      path: target.path,
      status: 'failed',
      messages: [],
      manifest: target.manifest as Record<string, unknown>,
      failure: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runAll(targets: PackageTarget[], concurrency: number): Promise<PublintResult[]> {
  let next = 0
  const results: Array<PublintResult | undefined> = []
  await Promise.all(Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next
      next += 1
      const target = targets[index]
      if (target === undefined) return
      results[index] = await runPublint(target)
    }
  }))

  return targets.map((target, index) => {
    const result = results[index]
    if (result === undefined) throw new Error(`publint-all: missing result for ${target.path}.`)
    return result
  })
}

function printResult(result: PublintResult): void {
  console.log(`Running publint for ${result.path}...`)
  if ('failure' in result) console.error(result.failure)
  for (const message of result.messages) {
    console.log(formatMessage(message, result.manifest, { color: false }) ?? message.code)
  }
  if (result.status === 'passed' && result.messages.length === 0) console.log('All good!')
}

const packages = workspacePackages()
const concurrency = publintConcurrency(packages.length)
console.log(`publint-all: linting ${packages.length} package(s) with ${concurrency} worker(s).`)

const results = await runAll(packages, concurrency)
for (const result of results) printResult(result)

if (results.some(result => result.status === 'failed')) process.exit(1)
