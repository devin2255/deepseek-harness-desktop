/** Repository-owned paths used by desktop packaging commands. */

import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute root of the repository containing this packaging module. */
export const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** Parent directory for every generated desktop packaging artifact. */
export const DESKTOP_ARTIFACT_ROOT = join(REPOSITORY_ROOT, '.artifacts/desktop')

/** Relocatable production runtime assembled for the desktop application. */
export const DESKTOP_STAGE = join(DESKTOP_ARTIFACT_ROOT, 'stage')

/** Output directory reserved for generated desktop installers. */
export const DESKTOP_INSTALLER = join(DESKTOP_ARTIFACT_ROOT, 'installer')

/** Desktop release version embedded in the installer filename and metadata. */
export const DESKTOP_VERSION = '0.1.0-rc.7'

/** Exact x64 Windows installer filename owned by the release workflow. */
export const DESKTOP_INSTALLER_NAME = `DeepSeek-Harness-Setup-${DESKTOP_VERSION}-x64.exe`

/**
 * Reject a path unless it is a descendant of the desktop artifact root.
 * @param path - Output path to validate.
 */
export function assertOwnedOutput(path: string): void {
  const candidate = resolve(path)
  const ownedRelative = relative(DESKTOP_ARTIFACT_ROOT, candidate)
  if (
    ownedRelative === ''
    || ownedRelative === '..'
    || ownedRelative.startsWith(`..${sep}`)
    || isAbsolute(ownedRelative)
  ) {
    throw new Error(`desktop packaging: output is outside ${DESKTOP_ARTIFACT_ROOT}: ${candidate}`)
  }
}
