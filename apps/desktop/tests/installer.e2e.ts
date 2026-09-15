import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertNoProductCollision,
  cleanupInstallerFixture,
  createInstallerFixture,
  exists,
  install,
  integrationPaths,
  readRegistryValue,
  redirectProductData,
  setInstalledVersion,
  uninstall,
  unlinkRedirect,
  verifyInstalledApplication,
  verifyLaunchAndClose,
  type InstallerFixture,
} from './installer-support.ts'

const INSTALLER_E2E_ENABLED = process.platform === 'win32'
  && process.arch === 'x64'
  && process.env.DSH_INSTALLER_E2E === '1'
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const DESKTOP_INSTALLER = join(REPOSITORY_ROOT, '.artifacts', 'desktop', 'installer')
const DESKTOP_INSTALLER_NAME = 'DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe'

describe.skipIf(!INSTALLER_E2E_ENABLED)('Windows installer lifecycle', { concurrent: false }, () => {
  let fixture: InstallerFixture
  const setup = join(DESKTOP_INSTALLER, DESKTOP_INSTALLER_NAME)

  beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-installer-e2e-'))
    fixture = await createInstallerFixture(root)
    await assertNoProductCollision(fixture)
    if (!await exists(setup)) throw new Error(`installer artifact is absent: ${setup}`)
  })

  afterAll(async () => {
    if (fixture !== undefined) await cleanupInstallerFixture(fixture)
  }, 660_000)

  it('accepts deterministic options only through an explicit E2E mode', async () => {
    const source = await readFile(join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh'), 'utf8')
    expect(source).toContain('"/DSH_E2E="')
    for (const option of ['DESKTOPSHORTCUT', 'STARTMENUSHORTCUT', 'AUTOSTART', 'LAUNCH', 'DELETEUSERDATA']) {
      expect(source).toContain(`DshReadAutomationBoolean ${option}`)
    }
    expect(source).toMatch(/DshAutomationSeen[\s\S]*DshE2eMode[\s\S]*DshRejectAutomation/u)
    expect(source).toMatch(/DshE2eMode == "1"[\s\S]*ReadEnvStr \$DshE2eDefaultInstall "DSH_INSTALLER_E2E_DEFAULT_INSTALL"/u)
    expect(source).toMatch(new RegExp([
      'DshRequestedLaunch == "1"',
      'ReadEnvStr \\$R2 "DSH_INSTALLER_E2E_ROOT"',
      'ReadEnvStr \\$R3 "DSH_INSTALLER_E2E_OWNERSHIP"',
      '--dsh-installer-e2e-root=',
      '--dsh-installer-e2e-ownership=',
    ].join('[\\s\\S]*'), 'u'))
    expect(source).toContain('FileSeek $9 0 END')
    expect(source).toContain('choices desktop=$DshDesktopShortcut start-menu=$DshStartMenuShortcut autostart=$DshLaunchAtLogin launch=$DshRequestedLaunch')
    expect(source).not.toMatch(/DSH_INSTALLER_E2E_(?:TOKEN|SECRET)/u)
  })

  it('rejects deterministic options without the explicit E2E gate', async () => {
    const rejected = join(fixture.root, 'rejected-install')
    await expect(install(setup, fixture, {
      install: rejected, desktop: 0, startMenu: 0, autostart: 0, launch: 0, gated: false,
    })).resolves.toBe(2)
    await expect(exists(join(rejected, 'DeepSeek Harness.exe'))).resolves.toBe(false)
  })

  it('installs to the isolated default destination with every option off and starts offline', async () => {
    await mkdir(join(fixture.home, '.dsh'), { recursive: true })
    await writeFile(join(fixture.home, '.dsh', 'cordis.yml'), ': corrupt existing harness home\n')
    await mkdir(join(fixture.productData, 'Harness'), { recursive: true })
    await writeFile(join(fixture.productData, 'Harness', 'corrupt-profile.yml'), ': corrupt product profile\n')
    await expect(timed('default install all-off', () => install(setup, fixture, {
      install: fixture.install, desktop: 0, startMenu: 0, autostart: 0, launch: 0, defaultDestination: true,
    }))).resolves.toBe(0)
    await expect(exists(join(fixture.install, 'DeepSeek Harness.exe'))).resolves.toBe(true)
    await expect(exists(fixture.desktopShortcut)).resolves.toBe(false)
    await expect(exists(fixture.startMenuShortcut)).resolves.toBe(false)
    await expect(readRegistryValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', fixture.runValue, fixture.environment))
      .resolves.toBeUndefined()
    await verifyInstalledApplication(fixture, fixture.install)
  }, 660_000)

  it('repairs the same version with every option on and honors LAUNCH', async () => {
    await expect(timed('same-version repair all-on', () => install(setup, fixture, {
      install: fixture.install, desktop: 1, startMenu: 1, autostart: 1, launch: 1, defaultDestination: true,
    }))).resolves.toBe(0)
    let launchClosed = false
    try {
      await verifyLaunchAndClose(fixture, fixture.install)
      launchClosed = true
      const integrations = {
        desktop: await exists(fixture.desktopShortcut),
        startMenu: await exists(fixture.startMenuShortcut),
        autostart: await readRegistryValue('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', fixture.runValue, fixture.environment),
      }
      expect(integrations).toEqual({
        desktop: true,
        startMenu: true,
        autostart: `"${join(fixture.install, 'DeepSeek Harness.exe')}"`,
      })
    } finally {
      if (!launchClosed) await verifyLaunchAndClose(fixture, fixture.install).catch(() => undefined)
    }
  }, 660_000)

  it('closes the running application before upgrading an older registered version with all options off', async () => {
    await setInstalledVersion(fixture, '0.1.0-rc.6')
    await verifyInstalledApplication(fixture, fixture.install, async () => {
      await expect(timed('running older-version upgrade all-off', () => install(setup, fixture, {
        install: fixture.install, desktop: 0, startMenu: 0, autostart: 0, launch: 0, defaultDestination: true,
      }))).resolves.toBe(0)
    })
    await expect(readRegistryValue(
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478',
      'DisplayVersion', fixture.environment,
    )).resolves.toBe('0.1.0-rc.7')
    await expect(exists(fixture.desktopShortcut)).resolves.toBe(false)
    await expect(exists(fixture.startMenuShortcut)).resolves.toBe(false)
  }, 630_000)

  it('preserves user data by default while removing installed state', async () => {
    const sentinel = join(fixture.productData, 'preserved.txt')
    await writeFile(sentinel, 'preserve')
    await expect(timed('default uninstall preserving data', () => uninstall(fixture, fixture.install, 0))).resolves.toBe(0)
    await expect(exists(join(fixture.install, 'DeepSeek Harness.exe'))).resolves.toBe(false)
    await expect(exists(sentinel)).resolves.toBe(true)
  }, 330_000)

  it('installs to a custom destination and deletes user data only when selected', async () => {
    await expect(timed('custom-destination install', () => install(setup, fixture, {
      install: fixture.customInstall, desktop: 0, startMenu: 0, autostart: 0, launch: 0,
    }))).resolves.toBe(0)
    await verifyInstalledApplication(fixture, fixture.customInstall)
    const sentinel = join(fixture.productData, 'delete-me.txt')
    await mkdir(fixture.productData, { recursive: true })
    await writeFile(sentinel, 'delete')
    const uninstallExit = await timed('custom uninstall deleting data', () => uninstall(fixture, fixture.customInstall, 1))
    if (uninstallExit !== 0) {
      const trace = await readFile(join(fixture.environment.TEMP ?? fixture.root, 'dsh-installer-e2e.log'), 'utf8').catch(() => '<trace absent>')
      throw new Error(`custom uninstall rejected ordinary fixture data: ${trace.trim()}`)
    }
    await expect(exists(join(fixture.customInstall, 'DeepSeek Harness.exe'))).resolves.toBe(false)
    await expect(exists(fixture.productData)).resolves.toBe(false)
  }, 930_000)

  it('refuses redirected user data and leaves its target untouched', async () => {
    await expect(timed('redirect-safety install', () => install(setup, fixture, {
      install: fixture.customInstall, desktop: 0, startMenu: 0, autostart: 0, launch: 0,
    }))).resolves.toBe(0)
    const target = join(fixture.root, 'redirect-target')
    const sentinel = join(target, 'must-survive.txt')
    await redirectProductData(fixture.productData, target)
    try {
      await writeFile(sentinel, 'survive')
      await expect(timed('redirected-data uninstall rejection', () => uninstall(fixture, fixture.customInstall, 1))).resolves.not.toBe(0)
      await expect(exists(sentinel)).resolves.toBe(true)
      await expect(exists(join(fixture.customInstall, 'DeepSeek Harness.exe'))).resolves.toBe(true)
    } finally {
      if (await exists(fixture.productData)) await unlinkRedirect(fixture.productData)
    }
    await expect(timed('post-rejection preserving uninstall', () => uninstall(fixture, fixture.customInstall, 0))).resolves.toBe(0)
    const integrations = await integrationPaths(fixture.customInstall, fixture.environment)
    await expect(exists(integrations.desktop)).resolves.toBe(false)
    await expect(exists(integrations.startMenu)).resolves.toBe(false)
  }, 1_230_000)
})

async function timed<T>(label: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now()
  try {
    return await operation()
  } finally {
    console.info(`installer E2E timing: ${label} ${Date.now() - startedAt}ms`)
  }
}
