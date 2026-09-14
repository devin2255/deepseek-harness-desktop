import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectPkgAssets } from './build-exe-for-python-sdk-assets.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('collectPkgAssets', () => {
  it('lists generated sibling chunks as exact portable pkg assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-pkg-assets-'))
    roots.push(root)
    createFile(root, 'package.json')
    createFile(root, 'node_modules', '@deepseek-ai', 'dsh-task', 'package.json')
    createFile(root, 'node_modules', '@deepseek-ai', 'dsh-task', 'lib', 'index.js')
    createFile(root, 'node_modules', '@deepseek-ai', 'dsh-task', 'lib', 'fold-DFJPiARH.js')
    createFile(root, 'node_modules', 'node-pty', 'build', 'Release', 'pty.node')
    createFile(root, 'node_modules', 'ignored', 'README.md')

    await expect(collectPkgAssets(root)).resolves.toEqual([
      'node_modules/@deepseek-ai/dsh-task/lib/fold-DFJPiARH.js',
      'node_modules/@deepseek-ai/dsh-task/lib/index.js',
      'node_modules/@deepseek-ai/dsh-task/package.json',
      'node_modules/node-pty/build/Release/pty.node',
      'package.json',
    ])
  })
})

function createFile(root: string, ...segments: string[]): void {
  const path = join(root, ...segments)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '')
}
