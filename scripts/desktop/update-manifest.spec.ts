import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { renderPackagedUpdateConfig, verifyPackagedUpdateConfig, verifyWindowsUpdateManifest } from './update-manifest.ts'

const builderConfig = 'publish:\n  provider: github\n  owner: devin2255\n  repo: deepseek-harness-desktop\n'

describe('Windows desktop update metadata', () => {
  it('keeps the installed feed pinned to the reviewed repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-config-'))
    try {
      const builder = join(root, 'builder.yml')
      const packaged = join(root, 'app-update.yml')
      await writeFile(builder, builderConfig)
      await writeFile(packaged, renderPackagedUpdateConfig(builderConfig))
      await expect(verifyPackagedUpdateConfig(packaged, builder)).resolves.toBeUndefined()
      await writeFile(packaged, builderConfig.replace('devin2255', 'deepseek-ai'))
      await expect(verifyPackagedUpdateConfig(packaged, builder)).rejects.toThrow(/differs from reviewed configuration/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts only the exact versioned installer and SHA-512 from latest.yml', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-manifest-'))
    try {
      const name = 'DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe'
      const installer = join(root, name)
      const manifest = join(root, 'latest.yml')
      const bytes = Buffer.from('installer fixture')
      const sha512 = createHash('sha512').update(bytes).digest('base64')
      const release = { version: '0.1.0-rc.7', files: [{ url: name, sha512 }], path: name, sha512 }
      await writeFile(installer, bytes)
      await writeFile(manifest, yaml.dump(release))
      await expect(verifyWindowsUpdateManifest(manifest, installer, release.version)).resolves.toBeUndefined()
      await writeFile(manifest, yaml.dump({ ...release, files: [{ url: '../other.exe', sha512 }] }))
      await expect(verifyWindowsUpdateManifest(manifest, installer, release.version)).rejects.toThrow(/installer entry differs/u)
      await writeFile(manifest, yaml.dump(release))
      await writeFile(installer, 'altered installer fixture')
      await expect(verifyWindowsUpdateManifest(manifest, installer, release.version)).rejects.toThrow(/SHA-512 differs/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
