import { copyFile } from 'node:fs/promises'
import { resolveBuiltAssetCopyRoot, resolveBuiltAssetWriteTarget } from './built-asset-root.mjs'

const copiedAssets = [
  ['src/startup.html', 'startup.html'],
  ['src/startup.css', 'startup.css'],
  ['build/tray.ico', 'tray.ico'],
  ['build/trayTemplate.png', 'trayTemplate.png'],
  ['build/trayTemplate@2x.png', 'trayTemplate@2x.png'],
]

/**
 * Copy source-owned static files into one built desktop package.
 * @param {URL} desktopRoot - Trusted desktop package root URL.
 * @returns {Promise<void>} Completion after all files are copied.
 */
export async function copyBuiltAssets(desktopRoot) {
  const paths = await resolveBuiltAssetCopyRoot(desktopRoot)
  for (const [source, destination] of copiedAssets) {
    const target = await resolveBuiltAssetWriteTarget(paths, destination)
    await copyFile(new URL(source, desktopRoot), target)
  }
}
