import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { verifyBuiltAssets } from '../scripts/built-asset-root.mjs'

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
      for (const name of ['startup-preload.cjs', 'startup-renderer.js', 'startup.html', 'startup.css']) {
        await writeFile(join(lib, name), name)
      }
      const desktopUrl = pathToFileURL(`${desktopRoot}${sep}`)
      await expect(verifyBuiltAssets(desktopUrl)).resolves.toBeUndefined()

      for (const missing of ['startup-preload.cjs', 'startup.html']) {
        await unlink(join(lib, missing))
        await expect(verifyBuiltAssets(desktopUrl)).rejects.toThrow(missing)
        await writeFile(join(lib, missing), missing)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
