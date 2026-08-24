import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const executeFile = promisify(execFile)

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

    expect(desktopManifest.scripts?.build).toContain('verify-built-assets.mjs')
    expect(desktopManifest.scripts?.build).toContain('clean-built-assets.mjs')
    expect(desktopManifest.scripts?.['test:built']).toContain('pnpm run build')
    expect(rootManifest.scripts?.['test:desktop:built']).toContain('test:built')
    expect(buildConfig).toContain("'startup-preload': 'lib/types/startup-preload.js'")
    expect(buildConfig).toContain("format: ['cjs']")
  })

  it('fails closed when a required built startup asset is missing', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-assets-'))
    const verifier = fileURLToPath(new URL('../scripts/verify-built-assets.mjs', import.meta.url))
    try {
      for (const name of ['startup-preload.cjs', 'startup-renderer.js', 'startup.html', 'startup.css']) {
        await writeFile(join(fixture, name), name)
      }
      await expect(executeFile(process.execPath, [verifier, fixture])).resolves.toBeDefined()

      for (const missing of ['startup-preload.cjs', 'startup.html']) {
        await unlink(join(fixture, missing))
        await expect(executeFile(process.execPath, [verifier, fixture])).rejects.toThrow(missing)
        await writeFile(join(fixture, missing), missing)
      }
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})
