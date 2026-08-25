import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createReleaseFiles, verifyReleaseFiles } from './checksum.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop release checksum and metadata', () => {
  it('atomically writes a conventional lowercase checksum and unsigned metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-files-'))
    roots.push(root)
    const artifact = join(root, 'DeepSeek-Harness-Setup-1.2.3-x64.exe')
    await writeFile(artifact, 'fixture')
    const result = await createReleaseFiles({
      outputRoot: root,
      artifact,
      version: '1.2.3',
      arch: 'x64',
      signature: { signed: false, signatureStatus: 'NotSigned' },
    })
    expect(await readFile(`${artifact}.sha256`, 'utf8')).toBe(`${result.sha256}  DeepSeek-Harness-Setup-1.2.3-x64.exe\n`)
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.parse(await readFile(join(root, 'release-metadata.json'), 'utf8'))).toMatchObject({
      version: '1.2.3', arch: 'x64', artifact: 'DeepSeek-Harness-Setup-1.2.3-x64.exe',
      bytes: 7, sha256: result.sha256, signed: false, signatureStatus: 'NotSigned',
    })
    await expect(verifyReleaseFiles({
      outputRoot: root, artifact, actualSignature: { signed: false, signatureStatus: 'NotSigned' },
    })).resolves.toMatchObject({ sha256: result.sha256 })
  })

  it('rejects output and artifact paths outside the exact release root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-files-'))
    roots.push(root)
    const outside = join(tmpdir(), `outside-${Date.now()}.exe`)
    await writeFile(outside, 'fixture')
    try {
      await expect(createReleaseFiles({
        outputRoot: root, artifact: outside, version: '1.0.0', arch: 'x64',
        signature: { signed: false, signatureStatus: 'NotSigned' },
      })).rejects.toThrow(/outside/u)
    } finally {
      await rm(outside, { force: true })
    }
  })

  it('detects an artifact changed after metadata generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-files-'))
    roots.push(root)
    const artifact = join(root, 'setup.exe')
    await writeFile(artifact, 'first')
    await createReleaseFiles({
      outputRoot: root, artifact, version: '1.0.0', arch: 'x64',
      signature: { signed: false, signatureStatus: 'NotSigned' },
    })
    await writeFile(artifact, 'changed')
    await expect(verifyReleaseFiles({ outputRoot: root, artifact })).rejects.toThrow(/checksum|metadata/u)
  })

  it('rejects extra fields, a mismatched release version, and metadata that contradicts Authenticode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-release-files-'))
    roots.push(root)
    const artifact = join(root, 'DeepSeek-Harness-Setup-1.2.3-x64.exe')
    await writeFile(artifact, 'fixture')
    await createReleaseFiles({
      outputRoot: root, artifact, version: '1.2.3', arch: 'x64',
      signature: { signed: false, signatureStatus: 'NotSigned' },
    })
    const metadataPath = join(root, 'release-metadata.json')
    const original = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>
    await writeFile(metadataPath, `${JSON.stringify({ ...original, unexpected: true })}\n`)
    const actualSignature = { signed: false, signatureStatus: 'NotSigned' } as const
    await expect(verifyReleaseFiles({ outputRoot: root, artifact, actualSignature })).rejects.toThrow(/fields/u)

    await writeFile(metadataPath, `${JSON.stringify({ ...original, version: '9.9.9' })}\n`)
    await expect(verifyReleaseFiles({ outputRoot: root, artifact, actualSignature })).rejects.toThrow(/version/u)

    await writeFile(metadataPath, `${JSON.stringify({ ...original, signed: true, signatureStatus: 'Valid' })}\n`)
    await expect(verifyReleaseFiles({ outputRoot: root, artifact, actualSignature })).rejects.toThrow(/signature|Authenticode/u)
  })
})
