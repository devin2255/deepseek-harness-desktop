import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyBuiltAssets } from '../scripts/built-asset-root.mjs'
import { copyBuiltAssets } from '../scripts/built-asset-copy.mjs'

describe('desktop built-asset gate', () => {
  it('is part of the formal build chain while source tests inspect no generated lib', async () => {
    const desktopManifest = JSON.parse(await readFile(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    )) as { readonly scripts?: Readonly<Record<string, string>> }
    const rootManifest = JSON.parse(await readFile(
      fileURLToPath(new URL('../../../package.json', import.meta.url)),
      'utf8',
    )) as { readonly scripts?: Readonly<Record<string, string>> }
    const buildConfig = await readFile(fileURLToPath(new URL('../tsdown.config.ts', import.meta.url)), 'utf8')
    const verifier = await readFile(fileURLToPath(new URL('../scripts/verify-built-assets.mjs', import.meta.url)), 'utf8')

    expect(desktopManifest.scripts?.build).toContain('verify-built-assets.mjs')
    expect(desktopManifest.scripts?.build).toContain('clean-built-assets.mjs')
    expect(desktopManifest.scripts?.build).toContain('copy-startup-assets.mjs')
    expect(desktopManifest.scripts?.['test:built']).toContain('pnpm run build')
    expect(rootManifest.scripts?.['test:desktop:built']).toContain('test:built')
    expect(buildConfig).toContain("'startup-preload': 'lib/types/startup-preload.js'")
    expect(buildConfig).toContain("format: ['cjs']")
    expect(verifier).not.toContain('process.argv')
  })

  it('fails closed when a required built startup asset is missing', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-'))
    const desktopRoot = join(fixture, 'desktop')
    const lib = join(desktopRoot, 'lib')
    try {
      await mkdir(lib, { recursive: true })
      for (const name of [
        'startup-preload.cjs',
        'startup-renderer.js',
        'startup.html',
        'startup.css',
        'tray.ico',
        'trayTemplate.png',
        'trayTemplate@2x.png',
      ]) {
        await writeFile(join(lib, name), name)
      }
      const desktopUrl = pathToFileURL(`${desktopRoot}${sep}`)
      await expect(verifyBuiltAssets(desktopUrl)).resolves.toBeUndefined()

      for (const missing of [
        'startup-preload.cjs',
        'startup.html',
        'tray.ico',
        'trayTemplate.png',
        'trayTemplate@2x.png',
      ]) {
        await unlink(join(lib, missing))
        await expect(verifyBuiltAssets(desktopUrl)).rejects.toThrow(missing)
        await writeFile(join(lib, missing), missing)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it('copies all tray variants from source-owned build assets', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-copy-assets-'))
    const desktopRoot = join(fixture, 'desktop')
    try {
      await mkdir(join(desktopRoot, 'src'), { recursive: true })
      await mkdir(join(desktopRoot, 'build'), { recursive: true })
      await mkdir(join(desktopRoot, 'lib'), { recursive: true })
      await writeFile(join(desktopRoot, 'src/startup.html'), 'startup html')
      await writeFile(join(desktopRoot, 'src/startup.css'), 'startup css')
      const expected = new Map([
        ['tray.ico', 'windows tray'],
        ['trayTemplate.png', 'mac tray'],
        ['trayTemplate@2x.png', 'mac retina tray'],
      ])
      for (const [name, content] of expected) await writeFile(join(desktopRoot, 'build', name), content)

      await copyBuiltAssets(pathToFileURL(`${desktopRoot}${sep}`))

      for (const [name, content] of expected) {
        await expect(readFile(join(desktopRoot, 'lib', name), 'utf8')).resolves.toBe(content)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
