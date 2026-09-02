import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  cleanupInstallerFixtureDirectory,
  createInstallerFixture,
  isFixtureRegistryState,
  hasInstallerCompletion,
  registerFixtureRuntimePackageRoot,
} from './installer-support.ts'

describe('installer completion evidence', () => {
  it('does not accept files from an earlier install without this run completing', () => {
    expect(hasInstallerCompletion(true, true, '')).toBe(false)
    expect(hasInstallerCompletion(true, true, 'automation accepted\r\n')).toBe(false)
  })

  it('requires both installed artifacts and an exact completion event', () => {
    expect(hasInstallerCompletion(true, true, 'custom install complete\r\n')).toBe(true)
    expect(hasInstallerCompletion(false, true, 'custom install complete\r\n')).toBe(false)
    expect(hasInstallerCompletion(true, false, 'custom install complete\r\n')).toBe(false)
    expect(hasInstallerCompletion(true, true, 'not custom install complete\r\n')).toBe(false)
  })
})

describe('installer E2E registry ownership', () => {
  const installRoot = 'C:\\Temp\\dsh-installer-e2e-owned\\default-install'
  const roots = [installRoot]

  it.each([
    { InstallLocation: installRoot },
    { UninstallString: `"${installRoot}\\Uninstall DeepSeek Harness.exe" /S` },
    { DshInstallerE2eRoot: installRoot },
  ])('accepts strong ownership evidence inside a fixture root', (values) => {
    expect(isFixtureRegistryState(values, roots)).toBe(true)
  })

  it.each([
    {},
    { DisplayVersion: '0.1.0-rc.6' },
    { InstallLocation: 'C:\\Program Files\\DeepSeek Harness' },
    { UninstallString: 'C:\\Program Files\\DeepSeek Harness\\Uninstall DeepSeek Harness.exe' },
    { DshInstallerE2eRoot: 'C:\\Temp\\another-fixture' },
  ])('rejects weak or out-of-fixture evidence', (values) => {
    expect(isFixtureRegistryState(values, roots)).toBe(false)
  })
})

describe.skipIf(process.platform !== 'win32')('installer E2E environment isolation', { concurrent: false }, () => {
  it('assigns different integration names to independent fixture roots', async () => {
    const firstRoot = await mkdtemp(join(tmpdir(), 'dsh-installer-environment-'))
    const secondRoot = await mkdtemp(join(tmpdir(), 'dsh-installer-environment-'))
    try {
      const first = await createInstallerFixture(firstRoot)
      const second = await createInstallerFixture(secondRoot)
      expect(first.desktopShortcut).not.toBe(second.desktopShortcut)
      expect(first.startMenuShortcut).not.toBe(second.startMenuShortcut)
      expect(first.runValue).not.toBe(second.runValue)
    } finally {
      await rm(firstRoot, { recursive: true, force: true })
      await rm(secondRoot, { recursive: true, force: true })
    }
  })

  it('isolates Harness data without replacing the Windows user profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installer-environment-'))
    try {
      const fixture = await createInstallerFixture(root)
      expect(fixture.environment.DSH_HOME).toBe(join(fixture.home, '.dsh'))
      expect(fixture.ownership).toMatch(/^[A-Za-z0-9_-]{43}$/u)
      expect(fixture.environment.DSH_INSTALLER_E2E_OWNERSHIP).toBe(fixture.ownership)
      await expect(readFile(join(root, '.dsh-installer-e2e-owner'), 'utf8')).resolves.toBe(`${fixture.ownership}\n`)
      expect(fixture.environment.USERPROFILE).toBe(process.env.USERPROFILE)
      expect(fixture.environment.HOME).toBe(process.env.HOME)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses recursive cleanup when any fixture descendant is a junction', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installer-environment-'))
    const target = await mkdtemp(join(tmpdir(), 'dsh-installer-target-'))
    const redirect = join(root, 'nested-redirect')
    try {
      const fixture = await createInstallerFixture(root)
      await writeFile(join(target, 'must-survive.txt'), 'survive')
      await symlink(target, redirect, 'junction')
      await expect(cleanupInstallerFixtureDirectory(fixture)).rejects.toThrow(/unowned installer fixture root/iu)
      await expect(readFile(join(target, 'must-survive.txt'), 'utf8')).resolves.toBe('survive')
    } finally {
      await unlink(redirect).catch(() => undefined)
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('unlinks only a generated package fallback junction whose target root was registered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installer-environment-'))
    const target = await mkdtemp(join(tmpdir(), 'dsh-installer-runtime-'))
    const redirect = join(root, 'appdata', 'roaming', 'DeepSeek Harness', 'Harness', 'profiles', 'node_modules', 'fixture-package')
    try {
      const fixture = await createInstallerFixture(root)
      await writeFile(join(target, 'must-survive.txt'), 'survive')
      await registerFixtureRuntimePackageRoot(fixture, target)
      await mkdir(dirname(redirect), { recursive: true })
      await symlink(target, redirect, 'junction')

      await cleanupInstallerFixtureDirectory(fixture)

      await expect(readFile(join(target, 'must-survive.txt'), 'utf8')).resolves.toBe('survive')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })

  it('unlinks a registered generated fallback junction after its packaged target was removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installer-environment-'))
    const target = await mkdtemp(join(tmpdir(), 'dsh-installer-runtime-'))
    const redirect = join(root, 'appdata', 'roaming', 'DeepSeek Harness', 'Harness', 'profiles', 'node_modules', 'fixture-package')
    try {
      const fixture = await createInstallerFixture(root)
      await registerFixtureRuntimePackageRoot(fixture, target)
      await mkdir(dirname(redirect), { recursive: true })
      await symlink(target, redirect, 'junction')
      await rm(target, { recursive: true })

      await cleanupInstallerFixtureDirectory(fixture)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(target, { recursive: true, force: true })
    }
  })
})
