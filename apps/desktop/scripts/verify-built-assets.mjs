import { lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const requiredAssets = ['startup-preload.cjs', 'startup-renderer.js', 'startup.html', 'startup.css']
const requestedRoot = process.argv[2]
const outputRoot = requestedRoot === undefined
  ? new URL('../lib/', import.meta.url)
  : pathToFileURL(`${resolve(requestedRoot)}${sep}`)

for (const name of requiredAssets) {
  const target = new URL(name, outputRoot)
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
