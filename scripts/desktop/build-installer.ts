/** Build the single repository-owned Windows desktop installer. */

import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readFile, readdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import yaml from 'js-yaml'

import { DESKTOP_INSTALLER, REPOSITORY_ROOT, assertOwnedOutput } from './packaging-layout.ts'
import { pnpmInvocation, resetStageDirectory } from './stage.ts'
import { verifyInstallerPowerShellCommands } from './generate-installer-powershell.ts'

const VERSION = '0.1.0-rc.7'
const INSTALLER_NAME = `DeepSeek-Harness-Setup-${VERSION}-x64.exe`

/** Return the pinned electron-builder CLI arguments. */
export function electronBuilderInvocation(): { readonly args: readonly string[] } {
  return {
    args: [
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--win', 'nsis', '--x64', '--publish', 'never',
    ],
  }
}

/** Reject every path except the exact versioned installer output. */
export function assertInstallerOutput(path: string): void {
  assertOwnedOutput(path)
  if (resolve(path) !== resolve(join(DESKTOP_INSTALLER, INSTALLER_NAME))) {
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

async function main(): Promise<void> {
  await verifyInstallerPowerShellCommands()
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'build'])
  runPnpm(['run', 'desktop:stage'])
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'electron', '--version'])
  await resetInstallerDirectory()
  const invocation = electronBuilderInvocation()
  runPnpm(
    ['--filter', '@deepseek-ai/dsh-desktop', 'exec', ...invocation.args],
    { ...process.env, DEBUG: 'electron-builder' },
  )
  verifyGeneratedInstallerScript(await readFile(join(DESKTOP_INSTALLER, 'builder-debug.yml'), 'utf8'))
  await resetStageDirectory(REPOSITORY_ROOT, join(DESKTOP_INSTALLER, 'win-unpacked'))
  await removeOrdinaryBuilderFile('builder-debug.yml')
  await removeOrdinaryBuilderFile('latest.yml')
  const entries = await readdir(DESKTOP_INSTALLER)
  if (entries.length !== 1) throw new Error(`desktop packaging: expected only one installer, found ${entries.length} outputs`)
  const output = join(DESKTOP_INSTALLER, entries[0] as string)
  assertInstallerOutput(output)
  const status = await lstat(output)
  if (!status.isFile() || status.isSymbolicLink()) throw new Error(`desktop packaging: installer is not an ordinary file: ${output}`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try { await main() } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
