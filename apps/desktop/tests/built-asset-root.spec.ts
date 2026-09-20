import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  cleanBuiltAssets,
  resolveBuiltAssetCopyRoot,
  resolveBuiltAssetWriteTarget,
  verifyBuiltAssets,
} from '../scripts/built-asset-root.mjs'

const requiredAssets = ['startup-preload.cjs', 'startup-renderer.js', 'startup.html', 'startup.css']

describe('desktop built-asset root guard', () => {
  it('rejects non-local URLs and non-directory desktop or lib roots', async () => {
    await expect(resolveBuiltAssetCopyRoot(new URL('https://example.com/desktop/'))).rejects.toThrow('local file URL')
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-invalid-root-'))
    const desktopRoot = join(fixture, 'desktop')
    try {
      await writeFile(desktopRoot, 'not a directory')
      await expect(resolveBuiltAssetCopyRoot(pathToFileURL(`${desktopRoot}${sep}`))).rejects.toThrow('must be a directory')
      await unlink(desktopRoot)
      await mkdir(desktopRoot)
      await writeFile(join(desktopRoot, 'lib'), 'not a directory')
      await expect(resolveBuiltAssetCopyRoot(pathToFileURL(`${desktopRoot}${sep}`))).rejects.toThrow('must be a directory')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects asset directories during cleanup and invalid or non-file write targets', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-invalid-asset-'))
    const desktopRoot = join(fixture, 'desktop')
    const lib = join(desktopRoot, 'lib')
    try {
      await mkdir(join(lib, 'startup-preload.cjs'), { recursive: true })
      const rootUrl = pathToFileURL(`${desktopRoot}${sep}`)
      await expect(cleanBuiltAssets(rootUrl)).rejects.toThrow('Refusing to replace directory')

      await rm(join(lib, 'startup-preload.cjs'), { recursive: true })
      const paths = await resolveBuiltAssetCopyRoot(rootUrl)
      await expect(resolveBuiltAssetWriteTarget(paths, '../outside')).rejects.toThrow('direct child')
      const target = await resolveBuiltAssetWriteTarget(paths, 'startup.html')
      expect(target).toBe(join(lib, 'startup.html'))
      await writeFile(target, 'ordinary file')
      await expect(resolveBuiltAssetWriteTarget(paths, 'startup.html')).resolves.toBe(target)
      await unlink(target)
      await mkdir(target)
      await expect(resolveBuiltAssetWriteTarget(paths, 'startup.html')).rejects.toThrow('ordinary file')
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects a lib directory link without reading, deleting, or changing external files', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-junction-'))
    const desktopRoot = join(fixture, 'desktop')
    const externalRoot = join(fixture, 'external')
    const lib = join(desktopRoot, 'lib')
    await mkdir(desktopRoot)
    await mkdir(externalRoot)
    const original = new Map<string, string>()
    for (const name of [...requiredAssets, 'sentinel.keep']) {
      const content = `external:${name}`
      original.set(name, content)
      await writeFile(join(externalRoot, name), content)
    }
    await symlink(externalRoot, lib, process.platform === 'win32' ? 'junction' : 'dir')

    try {
      const rootUrl = pathToFileURL(`${desktopRoot}${sep}`)
      await expect(cleanBuiltAssets(rootUrl)).rejects.toThrow('junction')
      await expect(verifyBuiltAssets(rootUrl)).rejects.toThrow('junction')

      for (const [name, content] of original) {
        expect(await readFile(join(externalRoot, name), 'utf8')).toBe(content)
      }
      expect((await lstat(lib)).isSymbolicLink()).toBe(true)
    } finally {
      await unlink(lib)
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('allows an absent lib and unlinks only a final asset link from an ordinary lib', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-asset-link-'))
    const desktopRoot = join(fixture, 'desktop')
    const externalRoot = join(fixture, 'external')
    const lib = join(desktopRoot, 'lib')
    const externalAsset = join(externalRoot, 'external.html')
    await mkdir(desktopRoot)
    await mkdir(externalRoot)
    await writeFile(externalAsset, 'external sentinel')
    const rootUrl = pathToFileURL(`${desktopRoot}${sep}`)

    try {
      await expect(cleanBuiltAssets(rootUrl)).resolves.toBeUndefined()
      await mkdir(lib)
      for (const name of requiredAssets.filter(name => name !== 'startup.html')) {
        await writeFile(join(lib, name), name)
      }
      await symlink(externalAsset, join(lib, 'startup.html'), 'file')

      await expect(verifyBuiltAssets(rootUrl)).rejects.toThrow('ordinary file')
      await expect(cleanBuiltAssets(rootUrl)).resolves.toBeUndefined()

      expect(await readFile(externalAsset, 'utf8')).toBe('external sentinel')
      await expect(lstat(join(lib, 'startup.html'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
