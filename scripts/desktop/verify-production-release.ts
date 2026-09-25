/** Production-only identity and Authenticode gate for a Windows desktop release. */

import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  inspectAuthenticode,
  inspectAuthenticodePublisher,
  type SignatureMetadata,
  verifyReleaseFiles,
} from './checksum.ts'
import {
  DESKTOP_INSTALLER,
  DESKTOP_INSTALLER_NAME,
  DESKTOP_VERSION,
  REPOSITORY_ROOT,
} from './packaging-layout.ts'
import { verifyPackagedUpdateConfig, verifyWindowsUpdateManifest } from './update-manifest.ts'

/** Require the checked-out tag to identify exactly the packaged desktop version. */
export function assertProductionReleaseTag(tag: string | undefined, version: string): void {
  if (tag !== `v${version}`) {
    throw new Error(`desktop production release: expected tag v${version}`)
  }
}

/** Require a valid Windows trust-chain result for one production executable. */
export function assertProductionSignature(label: string, signature: SignatureMetadata): void {
  if (!signature.signed || signature.signatureStatus !== 'Valid') {
    throw new Error(`desktop production release: ${label} is not Authenticode-valid`)
  }
}

async function main(): Promise<void> {
  assertProductionReleaseTag(process.env.GITHUB_REF_NAME, DESKTOP_VERSION)
  const installer = join(DESKTOP_INSTALLER, DESKTOP_INSTALLER_NAME)
  const release = await verifyReleaseFiles({
    outputRoot: DESKTOP_INSTALLER,
    artifact: installer,
    expectedVersion: DESKTOP_VERSION,
  })
  await verifyPackagedUpdateConfig(
    join(DESKTOP_INSTALLER, 'win-unpacked', 'resources', 'app-update.yml'),
    join(REPOSITORY_ROOT, 'apps', 'desktop', 'electron-builder.yml'),
    join(DESKTOP_INSTALLER, 'win-unpacked', 'DeepSeek Harness.exe'),
  )
  await verifyWindowsUpdateManifest(join(DESKTOP_INSTALLER, 'latest.yml'), installer, DESKTOP_VERSION)
  assertProductionSignature('installer', release)
  const application = inspectAuthenticode(join(DESKTOP_INSTALLER, 'win-unpacked', 'DeepSeek Harness.exe'))
  assertProductionSignature('installed application', application)
  const installerPublisher = inspectAuthenticodePublisher(installer)
  const applicationPublisher = inspectAuthenticodePublisher(join(DESKTOP_INSTALLER, 'win-unpacked', 'DeepSeek Harness.exe'))
  if (installerPublisher === undefined || installerPublisher !== applicationPublisher) {
    throw new Error('desktop production release: installer and application signing publishers differ')
  }
  console.log(JSON.stringify({ tag: process.env.GITHUB_REF_NAME, version: DESKTOP_VERSION, installer: release, application }))
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && pathToFileURL(resolve(invokedPath)).href === import.meta.url) {
  try { await main() } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
