import { basename, dirname, join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'

const copyControl = vi.hoisted(() => ({
  afterCopy: undefined as (() => Promise<void>) | undefined,
  lstatFailure: undefined as { readonly suffix: string; readonly error: Error } | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
      await actual.copyFile(args[0], args[1], args[2])
      await copyControl.afterCopy?.()
    },
    lstat: async (path: Parameters<typeof actual.lstat>[0]) => {
      if (copyControl.lstatFailure !== undefined && String(path).endsWith(copyControl.lstatFailure.suffix)) {
        throw copyControl.lstatFailure.error
      }
      return actual.lstat(path)
    },
  }
})

import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { copyBuiltAssets } from '../scripts/built-asset-copy.mjs'
import { cleanBuiltAssets } from '../scripts/built-asset-root.mjs'

const fixturePrefix = 'dsh-desktop-copy-guard-'

function assertOwnedFixture(fixture: string): void {
  const resolvedFixture = resolve(fixture)
  if (dirname(resolvedFixture) !== resolve(tmpdir()) || !basename(resolvedFixture).startsWith(fixturePrefix)) {
    throw new Error(`Refusing to remove unexpected test fixture: ${resolvedFixture}`)
  }
}

async function seedSources(desktopRoot: string): Promise<void> {
  await mkdir(join(desktopRoot, 'src'), { recursive: true })
  await mkdir(join(desktopRoot, 'build'), { recursive: true })
  await writeFile(join(desktopRoot, 'src', 'startup.html'), 'startup html')
  await writeFile(join(desktopRoot, 'src', 'startup.css'), 'startup css')
  await writeFile(join(desktopRoot, 'build', 'tray.ico'), 'windows tray')
  await writeFile(join(desktopRoot, 'build', 'trayTemplate.png'), 'mac tray')
  await writeFile(join(desktopRoot, 'build', 'trayTemplate@2x.png'), 'mac retina tray')
}

describe('desktop built-asset copy guard', () => {
  it('propagates unexpected target metadata failures during cleanup and copy', async () => {
    const fixture = await mkdtemp(join(tmpdir(), fixturePrefix))
    assertOwnedFixture(fixture)
    const desktopRoot = join(fixture, 'desktop')
    const rootUrl = pathToFileURL(`${desktopRoot}${sep}`)
    const metadataFailure = new Error('metadata failed')
    try {
      await seedSources(desktopRoot)
      await mkdir(join(desktopRoot, 'lib'))
      copyControl.lstatFailure = { suffix: 'startup-preload.cjs', error: metadataFailure }
      await expect(cleanBuiltAssets(rootUrl)).rejects.toBe(metadataFailure)

      copyControl.lstatFailure = { suffix: 'startup.html', error: metadataFailure }
      await expect(copyBuiltAssets(rootUrl)).rejects.toBe(metadataFailure)
    } finally {
      copyControl.lstatFailure = undefined
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rejects desktop and lib directory links without changing external sentinels', async () => {
    for (const linkedDirectory of ['desktop', 'lib'] as const) {
      const fixture = await mkdtemp(join(tmpdir(), fixturePrefix))
      assertOwnedFixture(fixture)
      const realDesktop = join(fixture, 'real-desktop')
      const desktopRoot = linkedDirectory === 'desktop' ? join(fixture, 'desktop') : realDesktop
      const externalRoot = linkedDirectory === 'desktop' ? realDesktop : join(fixture, 'external-lib')
      const link = linkedDirectory === 'desktop' ? desktopRoot : join(desktopRoot, 'lib')
      let linked = false
      try {
        await seedSources(realDesktop)
        await mkdir(join(realDesktop, 'lib'), { recursive: true })
        if (linkedDirectory === 'lib') await mkdir(externalRoot)
        const sentinel = join(externalRoot, 'lib', 'startup.html')
        if (linkedDirectory === 'lib') {
          await writeFile(join(externalRoot, 'startup.html'), 'external sentinel')
          await rm(join(realDesktop, 'lib'), { recursive: true })
          await symlink(externalRoot, link, process.platform === 'win32' ? 'junction' : 'dir')
        } else {
          await writeFile(sentinel, 'external sentinel')
          await symlink(realDesktop, link, process.platform === 'win32' ? 'junction' : 'dir')
        }
        linked = true

        await expect(copyBuiltAssets(pathToFileURL(`${desktopRoot}${sep}`))).rejects.toThrow(/symbolic link|junction/u)
        await expect(readFile(linkedDirectory === 'desktop' ? sentinel : join(externalRoot, 'startup.html'), 'utf8'))
          .resolves.toBe('external sentinel')
        expect((await lstat(link)).isSymbolicLink()).toBe(true)
      } finally {
        if (linked) await unlink(link)
        await rm(fixture, { recursive: true, force: true })
      }
    }
  })

  it('rejects a destination file link without changing its external target', async () => {
    const fixture = await mkdtemp(join(tmpdir(), fixturePrefix))
    assertOwnedFixture(fixture)
    const desktopRoot = join(fixture, 'desktop')
    const externalSentinel = join(fixture, 'external.html')
    const target = join(desktopRoot, 'lib', 'startup.html')
    let linked = false
    try {
      await seedSources(desktopRoot)
      await mkdir(join(desktopRoot, 'lib'))
      await writeFile(externalSentinel, 'external sentinel')
      await symlink(externalSentinel, target, 'file')
      linked = true

      await expect(copyBuiltAssets(pathToFileURL(`${desktopRoot}${sep}`))).rejects.toThrow('ordinary file')
      await expect(readFile(externalSentinel, 'utf8')).resolves.toBe('external sentinel')
    } finally {
      if (linked) await unlink(target)
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('rechecks the ordinary desktop and lib directories before every target write', async () => {
    const fixture = await mkdtemp(join(tmpdir(), fixturePrefix))
    assertOwnedFixture(fixture)
    const desktopRoot = join(fixture, 'desktop')
    const lib = join(desktopRoot, 'lib')
    const parkedLib = join(desktopRoot, 'parked-lib')
    const externalRoot = join(fixture, 'external-lib')
    const externalSentinel = join(externalRoot, 'startup.css')
    let linked = false
    let swapped = false
    try {
      await seedSources(desktopRoot)
      await mkdir(lib)
      await mkdir(externalRoot)
      await writeFile(externalSentinel, 'external sentinel')
      copyControl.afterCopy = async () => {
        if (swapped) return
        swapped = true
        await rename(lib, parkedLib)
        await symlink(externalRoot, lib, process.platform === 'win32' ? 'junction' : 'dir')
        linked = true
      }

      await expect(copyBuiltAssets(pathToFileURL(`${desktopRoot}${sep}`))).rejects.toThrow(/symbolic link|junction/u)
      await expect(readFile(externalSentinel, 'utf8')).resolves.toBe('external sentinel')
    } finally {
      copyControl.afterCopy = undefined
      if (linked) await unlink(lib)
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
