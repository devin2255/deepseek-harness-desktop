import { lstat, unlink } from 'node:fs/promises'

const outputRoot = new URL('../lib/', import.meta.url)
const generatedAssets = ['startup-preload.cjs', 'startup-renderer.js', 'startup.html', 'startup.css']

for (const name of generatedAssets) {
  const target = new URL(name, outputRoot)
  try {
    const metadata = await lstat(target)
    if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
      throw new Error(`Refusing to replace directory at desktop build asset: ${target.pathname}`)
    }
    await unlink(target)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
    throw error
  }
}
