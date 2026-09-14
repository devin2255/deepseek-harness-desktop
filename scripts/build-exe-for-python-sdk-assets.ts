/** Build the explicit pkg asset inventory for the Python SDK runtime. */

import { readdir } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const ASSET_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.mjs', '.node', '.wasm'])

/**
 * Enumerate every runtime file that pkg must place in its VFS.
 * @param staging - deployed runtime directory containing package.json and node_modules.
 * @returns sorted paths relative to the staged manifest, using pkg's portable separators.
 */
export async function collectPkgAssets(staging: string): Promise<string[]> {
  const assets = ['package.json']
  await collectDirectory(staging, join(staging, 'node_modules'), assets)
  return assets.sort()
}

async function collectDirectory(staging: string, directory: string, assets: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      await collectDirectory(staging, path, assets)
      continue
    }
    if (!entry.isFile() || !ASSET_EXTENSIONS.has(extname(entry.name))) continue
    assets.push(relative(staging, path).split(sep).join('/'))
  }
}
