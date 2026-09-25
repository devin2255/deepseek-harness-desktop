/** Build and inspect unsigned Apple Silicon desktop archives for native CI qualification. */

import { spawnSync } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertOwnedOutput,
  DESKTOP_INSTALLER,
  DESKTOP_VERSION,
  REPOSITORY_ROOT,
} from './packaging-layout.ts'
import { pnpmInvocation, resetStageDirectory } from './stage.ts'

const MAC_APP = join(DESKTOP_INSTALLER, 'mac-arm64', 'DeepSeek Harness.app')
const MAC_ARTIFACT_STEM = `DeepSeek-Harness-${DESKTOP_VERSION}-mac-arm64`

/**
 * Return the pinned electron-builder invocation for the configured arm64 DMG and ZIP targets.
 * @returns CLI arguments for the repository-owned Mac build configuration.
 */
export function electronBuilderMacInvocation(): { readonly args: readonly string[] } {
  return {
    args: [
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--mac', '--arm64', '--publish', 'never',
    ],
  }
}

function run(command: string, args: readonly string[], environment: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, [...args], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`macOS packaging: ${command} exited with ${String(result.status)}`)
  return result.stdout.trim()
}

function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): void {
  const pnpm = pnpmInvocation()
  const result = spawnSync(pnpm.command, [...pnpm.argsPrefix, ...args], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`macOS packaging: pnpm exited with ${String(result.status)}`)
}

/**
 * Reject credentials that could silently turn a test package into an unverified signed build.
 * @param environment - Environment supplied to the unsigned package command.
 */
export function assertUnsignedEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const name of [
    'CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD',
    'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE',
  ]) {
    if (environment[name] !== undefined) throw new Error(`macOS packaging: unsigned build cannot receive ${name}`)
  }
}

/**
 * Require the architecture and operating system exercised by this package lane.
 * @param platform - Node's current operating-system identifier.
 * @param architecture - Node's current CPU architecture identifier.
 */
export function assertMacHost(platform: NodeJS.Platform, architecture: string): void {
  if (platform !== 'darwin' || architecture !== 'arm64') {
    throw new Error('macOS packaging: an Apple Silicon macOS host is required')
  }
}

async function assertOrdinaryFile(path: string): Promise<void> {
  assertOwnedOutput(path)
  const status = await lstat(path)
  if (!status.isFile() || status.isSymbolicLink()) {
    throw new Error(`macOS packaging: expected an ordinary file: ${path}`)
  }
}

async function main(): Promise<void> {
  assertMacHost(process.platform, process.arch)
  assertUnsignedEnvironment(process.env)
  runPnpm(['--filter', '@deepseek-ai/dsh-desktop', 'build'])
  runPnpm(['run', 'desktop:stage'])
  assertOwnedOutput(DESKTOP_INSTALLER)
  await resetStageDirectory(REPOSITORY_ROOT, DESKTOP_INSTALLER)
  runPnpm(
    ['--filter', '@deepseek-ai/dsh-desktop', 'exec', ...electronBuilderMacInvocation().args],
    { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' },
  )

  const executable = join(MAC_APP, 'Contents', 'MacOS', 'DeepSeek Harness')
  await assertOrdinaryFile(executable)
  await assertOrdinaryFile(join(MAC_APP, 'Contents', 'Resources', 'app', 'lib', 'main.js'))
  await assertOrdinaryFile(join(MAC_APP, 'Contents', 'Resources', 'app', 'lib', 'preload.cjs'))
  const architectures = run('lipo', ['-archs', executable])
  if (architectures !== 'arm64') throw new Error(`macOS packaging: expected an arm64 executable, found ${architectures}`)

  const dmg = join(DESKTOP_INSTALLER, `${MAC_ARTIFACT_STEM}.dmg`)
  const zip = join(DESKTOP_INSTALLER, `${MAC_ARTIFACT_STEM}.zip`)
  await assertOrdinaryFile(dmg)
  await assertOrdinaryFile(zip)
  run('hdiutil', ['verify', dmg])
  run('unzip', ['-tq', zip])
  console.log(`macOS packaging: validated ${resolve(dmg)} and ${resolve(zip)} (unsigned test artifacts)`)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try { await main() } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
