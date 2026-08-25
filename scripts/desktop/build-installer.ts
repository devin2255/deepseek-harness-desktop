/** Build the single repository-owned Windows desktop installer. */

import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

import { createReleaseFiles, type SignatureMetadata } from './checksum.ts'
import {
  DESKTOP_INSTALLER,
  DESKTOP_INSTALLER_NAME,
  DESKTOP_STAGE,
  DESKTOP_VERSION,
  REPOSITORY_ROOT,
  assertOwnedOutput,
} from './packaging-layout.ts'
import { pnpmInvocation, resetStageDirectory } from './stage.ts'
import { pruneForeignNativePayloads, validatePackage } from './validate-package.ts'
import { verifyInstallerPowerShellCommands } from './generate-installer-powershell.ts'

const WIN_UNPACKED = join(DESKTOP_INSTALLER, 'win-unpacked')

/** Return the pinned electron-builder directory-build arguments. */
export function electronBuilderDirectoryInvocation(): { readonly args: readonly string[] } {
  return {
    args: [
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--win', '--x64', '--dir', '--publish', 'never',
    ],
  }
}

/** Return the pinned NSIS arguments consuming the already-validated unpacked directory. */
export function electronBuilderPrepackagedInvocation(): { readonly args: readonly string[] } {
  return {
    args: [
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--win', 'nsis', '--x64', '--publish', 'never',
      '--prepackaged', WIN_UNPACKED,
    ],
  }
}

/** Require an all-or-nothing Windows certificate environment. */
export function signingRequested(environment: NodeJS.ProcessEnv): boolean {
  const windowsPair = [environment.WIN_CSC_LINK, environment.WIN_CSC_KEY_PASSWORD] as const
  const genericPair = [environment.CSC_LINK, environment.CSC_KEY_PASSWORD] as const
  const present = [...windowsPair, ...genericPair].some(value => value !== undefined)
  if (!present) return false
  const windowsComplete = windowsPair.every(value => value !== undefined && value !== '')
  const genericComplete = genericPair.every(value => value !== undefined && value !== '')
  if (windowsComplete === genericComplete) {
    throw new Error('desktop packaging: incomplete signing environment')
  }
  return true
}

/** Reject every path except the exact versioned installer output. */
export function assertInstallerOutput(path: string): void {
  assertOwnedOutput(path)
  if (resolve(path) !== resolve(join(DESKTOP_INSTALLER, DESKTOP_INSTALLER_NAME))) {
    throw new Error(`desktop packaging: unexpected installer output: ${path}`)
  }
}

/** Parse square image dimensions from a Windows ICO directory. */
export function parseIcoDimensions(buffer: Buffer): number[] {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('desktop packaging: invalid Windows icon header')
  }
  const count = buffer.readUInt16LE(4)
  if (buffer.length < 6 + count * 16) throw new Error('desktop packaging: truncated Windows icon directory')
  return Array.from({ length: count }, (_, index) => {
    const width = buffer.readUInt8(6 + index * 16)
    const height = buffer.readUInt8(7 + index * 16)
    if (width !== height) throw new Error('desktop packaging: icon image is not square')
    return width === 0 ? 256 : width
  })
}

/** Verify the builder-composed NSIS script uses the reviewed assisted-template ordering. */
export function verifyGeneratedInstallerScript(debugYaml: string): void {
  const debug = yaml.load(debugYaml) as { readonly nsis?: { readonly script?: unknown } }
  const script = debug.nsis?.script
  if (typeof script !== 'string') throw new Error('desktop packaging: builder diagnostics omit the NSIS script')
  const customInclude = script.search(/!include "[^\n]*apps[\\/]desktop[\\/]build[\\/]installer\.nsh"/u)
  const multiUserInclude = script.indexOf('!include "multiUser.nsh"')
  const assistedInclude = script.indexOf('!include "assistedInstaller.nsh"')
  if (customInclude < 0 || multiUserInclude < 0 || assistedInclude < 0) {
    throw new Error('desktop packaging: generated NSIS script omits an assisted-installer component')
  }
  if (customInclude > multiUserInclude || multiUserInclude > assistedInclude) {
    throw new Error('desktop packaging: custom per-user hooks are not defined before assisted pages')
  }
}

async function resetInstallerDirectory(): Promise<void> {
  assertOwnedOutput(DESKTOP_INSTALLER)
  await resetStageDirectory(REPOSITORY_ROOT, DESKTOP_INSTALLER)
  await mkdir(DESKTOP_INSTALLER)
}

async function removeOrdinaryBuilderFile(name: string): Promise<void> {
  const path = join(DESKTOP_INSTALLER, name)
  assertOwnedOutput(path)
  let status
  try { status = await lstat(path) } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  if (!status.isFile() && !status.isSymbolicLink()) {
    throw new Error(`desktop packaging: builder side output is not an ordinary file or link: ${path}`)
  }
  await unlink(path)
}

function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): void {
  const pnpm = pnpmInvocation()
  const result = spawnSync(pnpm.command, [...pnpm.argsPrefix, ...args], {
    cwd: REPOSITORY_ROOT, stdio: 'inherit', env: environment,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`desktop packaging: pnpm exited with ${String(result.status)}`)
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
    throw new Error('desktop packaging: Windows module roots are unavailable')
  }
  return {
    ...environment,
    DSH_SIGNATURE_ARTIFACT: path,
    PSModulePath: [
      join(systemRoot, 'system32/WindowsPowerShell/v1.0/Modules'),
      join(programFiles, 'WindowsPowerShell/Modules'),
    ].join(';'),
  }
}

function inspectAuthenticode(path: string, requireValid: boolean): SignatureMetadata {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', authenticodePowerShellCommand(),
  ], {
    cwd: DESKTOP_INSTALLER,
    encoding: 'utf8',
    env: authenticodeEnvironment(path, process.env),
    windowsHide: true,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error('desktop packaging: Authenticode inspection failed')
  const status = result.stdout.trim()
  if (requireValid && status !== 'Valid') throw new Error('desktop packaging: requested signature is not valid')
  if (!requireValid && status !== 'NotSigned') throw new Error('desktop packaging: unexpected signature state without signing configuration')
  return { signed: status === 'Valid', signatureStatus: status }
}

async function main(): Promise<void> {
  await verifyInstallerPowerShellCommands()
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'build'])
  runPnpm(['run', 'desktop:stage'])
  const prunedNativeFiles = await pruneForeignNativePayloads(DESKTOP_STAGE)
  console.log(`desktop packaging: pruned ${prunedNativeFiles} foreign native files`)
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'electron', '--version'])
  await resetInstallerDirectory()
  const directoryInvocation = electronBuilderDirectoryInvocation()
  runPnpm(
    ['--filter', '@deepseek-ai/dsh-desktop', 'exec', ...directoryInvocation.args],
    { ...process.env, DEBUG: 'electron-builder' },
  )
  const prunedUnpackedFiles = await pruneForeignNativePayloads(WIN_UNPACKED)
  if (prunedUnpackedFiles !== prunedNativeFiles) {
    throw new Error('desktop packaging: staged and unpacked foreign native inventories differ')
  }
  const validatedInput = await validatePackage({ packageRoot: WIN_UNPACKED })
  const prepackagedInvocation = electronBuilderPrepackagedInvocation()
  runPnpm(
    ['--filter', '@deepseek-ai/dsh-desktop', 'exec', ...prepackagedInvocation.args],
    { ...process.env, DEBUG: 'electron-builder' },
  )
  const validatedAfterNsis = await validatePackage({ packageRoot: WIN_UNPACKED })
  if (JSON.stringify(validatedAfterNsis) !== JSON.stringify(validatedInput)) {
    throw new Error('desktop packaging: NSIS build changed the validated application input')
  }
  verifyGeneratedInstallerScript(await readFile(join(DESKTOP_INSTALLER, 'builder-debug.yml'), 'utf8'))
  await removeOrdinaryBuilderFile('builder-debug.yml')
  await removeOrdinaryBuilderFile('latest.yml')
  const entries = (await readdir(DESKTOP_INSTALLER)).filter(name => name !== 'win-unpacked')
  if (entries.length !== 1 || entries[0] !== DESKTOP_INSTALLER_NAME) {
    throw new Error(`desktop packaging: expected one exact installer, found ${entries.length} outputs`)
  }
  const output = join(DESKTOP_INSTALLER, DESKTOP_INSTALLER_NAME)
  assertInstallerOutput(output)
  const status = await lstat(output)
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`desktop packaging: installer is not an ordinary file: ${output}`)
  const signature = inspectAuthenticode(output, signingRequested(process.env))
  await createReleaseFiles({
    outputRoot: DESKTOP_INSTALLER,
    artifact: output,
    version: DESKTOP_VERSION,
    arch: 'x64',
    signature,
  })
  const finalEntries = new Set(await readdir(DESKTOP_INSTALLER))
  const expected = new Set(['win-unpacked', DESKTOP_INSTALLER_NAME, `${DESKTOP_INSTALLER_NAME}.sha256`, 'release-metadata.json'])
  if (finalEntries.size !== expected.size || [...expected].some(name => !finalEntries.has(name))) {
    throw new Error('desktop packaging: release directory contains unexpected outputs')
  }
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try { await main() } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
