import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  assertOwnedOutput,
  DESKTOP_ARTIFACT_ROOT,
  DESKTOP_INSTALLER,
  DESKTOP_STAGE,
  REPOSITORY_ROOT,
} from './packaging-layout.ts'
import { assertRelocatableLink, deploymentManifest, pnpmInvocation } from './stage.ts'

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const sourceManifest = JSON.parse(readFileSync(join(repositoryRoot, 'apps/desktop/package.json'), 'utf8')) as Record<string, unknown>
const rootManifest = JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')) as {
  readonly scripts?: Record<string, string>
}

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
})
