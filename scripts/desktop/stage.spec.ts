/** Desktop production staging behavior and path-safety tests. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { lstat as lstatAsync } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertOwnedOutput,
  DESKTOP_ARTIFACT_ROOT,
  DESKTOP_INSTALLER,
  DESKTOP_STAGE,
  REPOSITORY_ROOT,
} from './packaging-layout.ts'
import {
  assertRelocatableLink,
  deploymentManifest,
  materializeWorkspaceLinks,
  pnpmInvocation,
  resetStageDirectory,
  resolveBundleManifest,
} from './stage.ts'

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const sourceManifest = JSON.parse(readFileSync(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as Record<string, unknown>
const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Record<string, string>
}
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('desktop packaging layout', () => {
  it('derives every output beneath the repository-owned desktop artifact directory', () => {
    expect(REPOSITORY_ROOT).toBe(repositoryRoot)
    expect(DESKTOP_ARTIFACT_ROOT).toBe(join(repositoryRoot, '.artifacts/desktop'))
    expect(DESKTOP_STAGE).toBe(join(DESKTOP_ARTIFACT_ROOT, 'stage'))
    expect(DESKTOP_INSTALLER).toBe(join(DESKTOP_ARTIFACT_ROOT, 'installer'))
    assertOwnedOutput(join(DESKTOP_STAGE, 'package.json'))
    assertOwnedOutput(join(DESKTOP_INSTALLER, 'DeepSeek Harness.exe'))
  })

  it.each([
    ['artifact root', DESKTOP_ARTIFACT_ROOT],
    ['sibling', join(dirname(DESKTOP_ARTIFACT_ROOT), 'other')],
    ['ancestor', dirname(DESKTOP_ARTIFACT_ROOT)],
    ['absolute escape', resolve(DESKTOP_ARTIFACT_ROOT, '..', '..', 'escape')],
  ])('rejects the %s as an owned output', (_label, candidate) => {
    expect(() => {
      assertOwnedOutput(candidate)
    }).toThrow(`outside ${DESKTOP_ARTIFACT_ROOT}`)
  })
})

describe('desktop production staging', () => {
  it('creates a relocatable desktop deployment manifest', () => {
    const manifest = deploymentManifest({
      ...sourceManifest,
      repositoryPathForTest: repositoryRoot,
    })

    expect(manifest).toMatchObject({
      name: '@deepseek-ai/dsh-desktop',
      main: 'lib/main.js',
      version: sourceManifest.version,
      dependencies: sourceManifest.dependencies,
    })
    expect(manifest).not.toHaveProperty('scripts')
    expect(manifest).not.toHaveProperty('devDependencies')
    expect(manifest).not.toHaveProperty('repository')
    expect(manifest).not.toHaveProperty('publishConfig')
    expect(manifest).not.toHaveProperty('files')
    expect(JSON.stringify(manifest)).not.toContain(repositoryRoot)
  })

  it('pins the desktop packaging commands at the repository root', () => {
    expect(rootManifest.scripts).toMatchObject({
      'desktop:stage': 'tsx scripts/desktop/stage.ts',
      'desktop:package': 'tsx scripts/desktop/build-installer.ts',
      'desktop:validate-package': 'tsx scripts/desktop/validate-package.ts',
      'test:desktop:installer': 'vitest run --config vitest.desktop-installer.config.ts',
    })
  })

  it('launches repository-pinned pnpm through Corepack without a Windows command shell', () => {
    expect(pnpmInvocation('C:\\tools\\corepack.js')).toEqual({
      command: process.execPath,
      argsPrefix: ['C:\\tools\\corepack.js', 'pnpm'],
    })
  })

  it('allows only links whose resolved targets remain inside the stage', () => {
    const link = join(DESKTOP_STAGE, 'node_modules/example')
    assertRelocatableLink(link, '../.pnpm/example')
    expect(() => {
      assertRelocatableLink(link, resolve(REPOSITORY_ROOT, 'apps/cli'))
    }).toThrow(link)
  })

  it('resolves bundle manifests from the real pnpm package installation', async () => {
    const stage = mkdtempSync(join(tmpdir(), 'dsh-desktop-stage-'))
    temporaryDirectories.push(stage)
    const installation = join(stage, 'node_modules/.pnpm/dsh/node_modules/@deepseek-ai')
    const realDsh = join(installation, 'dsh')
    const bundle = join(installation, 'dsh-base')
    const logicalDsh = join(stage, 'node_modules/@deepseek-ai/dsh')
    mkdirSync(realDsh, { recursive: true })
    mkdirSync(bundle, { recursive: true })
    mkdirSync(dirname(logicalDsh), { recursive: true })
    writeFileSync(join(realDsh, 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
    writeFileSync(join(bundle, 'package.json'), '{"name":"@deepseek-ai/dsh-base"}\n')
    symlinkSync(
      process.platform === 'win32' ? realDsh : relative(dirname(logicalDsh), realDsh),
      logicalDsh,
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(resolveBundleManifest('@deepseek-ai/dsh-base', join(logicalDsh, 'package.json'), stage))
      .resolves.toBe(join(bundle, 'package.json'))
  })

  it('rejects a bundle manifest resolved only from ancestor node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-resolution-'))
    temporaryDirectories.push(root)
    const stage = join(root, 'stage')
    const dsh = join(stage, 'node_modules/@deepseek-ai/dsh')
    const ancestorBundle = join(root, 'node_modules/@deepseek-ai/dsh-base')
    mkdirSync(dsh, { recursive: true })
    mkdirSync(ancestorBundle, { recursive: true })
    writeFileSync(join(dsh, 'package.json'), '{"name":"@deepseek-ai/dsh"}\n')
    writeFileSync(join(ancestorBundle, 'package.json'), '{"name":"@deepseek-ai/dsh-base"}\n')

    await expect(resolveBundleManifest('@deepseek-ai/dsh-base', join(dsh, 'package.json'), stage))
      .rejects.toThrow('outside staged runtime')
  })

  it('refuses deletion through a link-shaped artifact ancestor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-repository-'))
    const external = mkdtempSync(join(tmpdir(), 'dsh-desktop-external-'))
    temporaryDirectories.push(root, external)
    const artifactLink = join(root, '.artifacts')
    const externalStage = join(external, 'desktop/stage')
    const sentinel = join(externalStage, 'sentinel.txt')
    mkdirSync(externalStage, { recursive: true })
    writeFileSync(sentinel, 'keep\n')
    symlinkSync(external, artifactLink, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(resetStageDirectory(root, join(root, '.artifacts/desktop/stage')))
      .rejects.toThrow('link-shaped ancestor')
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n')
    unlinkSync(artifactLink)
  })

  it('unlinks a link-shaped stage leaf without modifying its target', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-repository-'))
    const external = mkdtempSync(join(tmpdir(), 'dsh-desktop-external-'))
    temporaryDirectories.push(root, external)
    const stage = join(root, '.artifacts/desktop/stage')
    const sentinel = join(external, 'sentinel.txt')
    mkdirSync(dirname(stage), { recursive: true })
    writeFileSync(sentinel, 'keep\n')
    symlinkSync(external, stage, process.platform === 'win32' ? 'junction' : 'dir')

    await resetStageDirectory(root, stage)

    expect(existsSync(stage)).toBe(false)
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n')
  })

  it('refuses materialization when a scanned link changes before replacement', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-repository-'))
    const victim = mkdtempSync(join(tmpdir(), 'dsh-desktop-victim-'))
    temporaryDirectories.push(root, victim)
    const stage = join(root, '.artifacts/desktop/stage')
    const source = join(root, 'vendor/cosmokit')
    const link = join(stage, 'node_modules/@deepseek-ai/cosmokit')
    const sentinel = join(victim, 'sentinel.txt')
    mkdirSync(source, { recursive: true })
    mkdirSync(dirname(link), { recursive: true })
    writeFileSync(join(source, 'package.json'), '{"name":"@deepseek-ai/cosmokit"}\n')
    writeFileSync(sentinel, 'keep\n')
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir')

    await expect(materializeWorkspaceLinks(stage, root, {
      lstat: async (path) => {
        const stats = await lstatAsync(path)
        unlinkSync(path)
        symlinkSync(victim, path, process.platform === 'win32' ? 'junction' : 'dir')
        return stats
      },
    })).rejects.toThrow('changed before replacement')
    expect(readFileSync(sentinel, 'utf8')).toBe('keep\n')
    unlinkSync(link)
  })
})
