import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { hasAuthenticodeCertificate, inspectAuthenticodePublisher } from './checksum.ts'
import { renderPackagedUpdateConfig, verifyPackagedUpdateConfig, verifyWindowsUpdateManifest } from './update-manifest.ts'

const builderConfig = 'publish:\n  provider: github\n  owner: devin2255\n  repo: deepseek-harness-desktop\n'

describe('Windows desktop update metadata', () => {
  it('keeps the installed feed pinned to the reviewed repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-config-'))
    try {
      const builder = join(root, 'builder.yml')
      const packaged = join(root, 'app-update.yml')
      const application = join(root, 'DeepSeek Harness.exe')
      await writeFile(builder, builderConfig)
      await writeFile(application, unsignedPortableExecutable())
      await writeFile(packaged, renderPackagedUpdateConfig(builderConfig))
      await expect(verifyPackagedUpdateConfig(packaged, builder, application)).resolves.toBeUndefined()
      await writeFile(packaged, builderConfig.replace('devin2255', 'deepseek-ai'))
      await expect(verifyPackagedUpdateConfig(packaged, builder, application)).rejects.toThrow(/differs from reviewed configuration/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('requires the signed publisher common name in packaged update settings', () => {
    expect(yaml.load(renderPackagedUpdateConfig(builderConfig, 'DeepSeek Harness Publisher'))).toEqual({
      provider: 'github', owner: 'devin2255', repo: 'deepseek-harness-desktop',
      updaterCacheDirName: '@deepseek-aidsh-desktop-updater',
      publisherName: ['DeepSeek Harness Publisher'],
    })
  })

  it.skipIf(process.platform !== 'win32' || !hasAuthenticodeCertificate(process.execPath))('rejects a signed application without its trusted update publisher', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-update-signed-config-'))
    try {
      const builder = join(root, 'builder.yml')
      const packaged = join(root, 'app-update.yml')
      await writeFile(builder, builderConfig)
      await writeFile(packaged, renderPackagedUpdateConfig(builderConfig))
      await expect(verifyPackagedUpdateConfig(packaged, builder, process.execPath)).rejects.toThrow(/differs from reviewed configuration/u)
      await writeFile(packaged, renderPackagedUpdateConfig(builderConfig, inspectAuthenticodePublisher(process.execPath)))
      await expect(verifyPackagedUpdateConfig(packaged, builder, process.execPath)).resolves.toBeUndefined()
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

function unsignedPortableExecutable(): Buffer {
  const value = Buffer.alloc(544)
  const peOffset = 0x80
  const optionalOffset = peOffset + 24
  value.write('MZ', 0, 'ascii')
  value.writeUInt32LE(peOffset, 0x3c)
  value.write('PE\0\0', peOffset, 'binary')
  value.writeUInt16LE(240, peOffset + 20)
  value.writeUInt16LE(0x20b, optionalOffset)
  value.writeUInt32LE(16, optionalOffset + 108)
  return value
}
