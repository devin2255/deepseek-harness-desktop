/** Build the single repository-owned Windows desktop installer. */

import { spawnSync } from 'node:child_process'
import { lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { DESKTOP_INSTALLER, REPOSITORY_ROOT, assertOwnedOutput } from './packaging-layout.ts'
import { pnpmInvocation, validateRealAncestors } from './stage.ts'

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

async function resetInstallerDirectory(): Promise<void> {
  assertOwnedOutput(DESKTOP_INSTALLER)
  await validateRealAncestors(REPOSITORY_ROOT, dirname(DESKTOP_INSTALLER))
  await mkdir(dirname(DESKTOP_INSTALLER), { recursive: true })
  await validateRealAncestors(REPOSITORY_ROOT, dirname(DESKTOP_INSTALLER))
  try {
    const status = await lstat(DESKTOP_INSTALLER)
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw new Error(`desktop packaging: installer output is link-shaped or not a directory: ${DESKTOP_INSTALLER}`)
    }
    const quarantine = join(dirname(DESKTOP_INSTALLER), `.installer-old-${process.pid}`)
    await rename(DESKTOP_INSTALLER, quarantine)
    await rm(quarantine, { recursive: true })
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  await mkdir(DESKTOP_INSTALLER)
}

function runPnpm(args: readonly string[]): void {
  const pnpm = pnpmInvocation()
  const result = spawnSync(pnpm.command, [...pnpm.argsPrefix, ...args], {
    cwd: REPOSITORY_ROOT, stdio: 'inherit', env: process.env,
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`desktop packaging: pnpm exited with ${String(result.status)}`)
}

async function main(): Promise<void> {
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'build'])
  runPnpm(['run', 'desktop:stage'])
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'exec', 'electron', '--version'])
  await resetInstallerDirectory()
  const invocation = electronBuilderInvocation()
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'exec', ...invocation.args])
  const entries = (await readdir(DESKTOP_INSTALLER)).filter(name => name.toLowerCase().endsWith('.exe'))
  if (entries.length !== 1) throw new Error(`desktop packaging: expected exactly one installer, found ${entries.length}`)
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
