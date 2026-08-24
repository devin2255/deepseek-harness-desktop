import { lstat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const generatedAssets = ['startup-preload.cjs', 'startup-renderer.js', 'startup.html', 'startup.css']

/**
 * Guard and remove generated startup assets below one trusted desktop source root.
 * @param {URL} desktopRoot - Trusted file URL for the desktop package directory.
 * @returns {Promise<void>} Completion after safe asset removal or an absent lib directory.
 */
export async function cleanBuiltAssets(desktopRoot) {
  const paths = await resolveGuardedAssetRoot(desktopRoot, true)
  if (paths === undefined) return
  for (const name of generatedAssets) {
    await assertGuardedAssetRoot(paths)
    const target = join(paths.lib, name)
    let metadata
    try {
      metadata = await lstat(target)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace directory at desktop build asset: ${name}`)
    }
    await unlink(target)
  }
}

/**
 * Guard and verify generated startup assets below one trusted desktop source root.
 * @param {URL} desktopRoot - Trusted file URL for the desktop package directory.
 * @returns {Promise<void>} Completion after every required asset passes verification.
 */
export async function verifyBuiltAssets(desktopRoot) {
  const paths = await resolveGuardedAssetRoot(desktopRoot, false)
  for (const name of generatedAssets) {
    await assertGuardedAssetRoot(paths)
    const target = join(paths.lib, name)
    let metadata
    try {
      metadata = await lstat(target)
    } catch (error) {
      throw new Error(`Missing required desktop build asset: ${name}`, { cause: error })
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Desktop build asset must be an ordinary file: ${name}`)
    }
  }
}

/** Resolve the fixed direct lib child without following either guarded directory. */
async function resolveGuardedAssetRoot(desktopRoot, allowMissingLib) {
  if (
    desktopRoot.protocol !== 'file:'
    || desktopRoot.username !== ''
    || desktopRoot.password !== ''
    || desktopRoot.hostname !== ''
  ) {
    throw new Error('Desktop build root must be a local file URL')
  }
  const desktop = fileURLToPath(desktopRoot)
  const paths = { desktop, lib: join(desktop, 'lib') }
  await assertOrdinaryDirectory(paths.desktop, 'desktop package root')
  try {
    await assertOrdinaryDirectory(paths.lib, 'desktop lib root')
  } catch (error) {
    if (allowMissingLib && isMissing(error)) return undefined
    throw error
  }
  return paths
}

/** Recheck both owned directories immediately before each asset operation. */
async function assertGuardedAssetRoot(paths) {
  await assertOrdinaryDirectory(paths.desktop, 'desktop package root')
  await assertOrdinaryDirectory(paths.lib, 'desktop lib root')
}

/** Reject a missing, linked, junction, or non-directory path without resolving through it. */
async function assertOrdinaryDirectory(path, label) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link or junction`)
  }
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory`)
}

/** Recognize only the filesystem's absent-path result. */
function isMissing(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
