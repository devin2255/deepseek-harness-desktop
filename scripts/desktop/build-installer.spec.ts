import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

import {
  assertInstallerOutput,
  electronBuilderInvocation,
  parseIcoDimensions,
} from './build-installer.ts'
import { DESKTOP_INSTALLER, REPOSITORY_ROOT } from './packaging-layout.ts'

interface InstallerConfig {
  readonly appId: string
  readonly productName: string
  readonly asar: boolean
  readonly artifactName: string
  readonly win: { readonly target: Array<{ readonly target: string; readonly arch: string[] }>; readonly requestedExecutionLevel: string }
  readonly nsis: Record<string, unknown>
}

const configPath = join(REPOSITORY_ROOT, 'apps/desktop/electron-builder.yml')
const includePath = join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh')

describe('Windows installer configuration', () => {
  it('pins one assisted per-user offline x64 NSIS installer without elevation', async () => {
    const config = yaml.load(await readFile(configPath, 'utf8')) as InstallerConfig
    expect(config).toMatchObject({
      appId: 'ai.deepseek.harness.desktop', productName: 'DeepSeek Harness', asar: false,
      artifactName: 'DeepSeek-Harness-Setup-${version}-x64.${ext}',
      win: { target: [{ target: 'nsis', arch: ['x64'] }], requestedExecutionLevel: 'asInvoker' },
      nsis: {
        oneClick: false, perMachine: false, allowElevation: false,
        allowToChangeInstallationDirectory: true, runAfterFinish: true,
        guid: '5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478',
        createDesktopShortcut: false, createStartMenuShortcut: false,
      },
    })
    expect(JSON.stringify(config)).not.toMatch(/nsis-web|webInstaller/iu)
  })

  it('declares real builder hooks for pages, persisted choices, cleanup authentication, and retryable shutdown', async () => {
    const source = await readFile(includePath, 'utf8')
    const macros = [...source.matchAll(/^!macro\s+(\w+)/gmu)].map(match => match[1])
    expect(macros).toEqual(expect.arrayContaining([
      'customWelcomePage', 'customPageAfterChangeDir', 'customInit', 'customInstall',
      'customUnInstallSection', 'customUnInstall', 'customCheckAppRunning',
    ]))
    expect(source).toMatch(/\$\{isUpdated\}[\s\S]*ReadRegStr[\s\S]*DesktopShortcut/u)
    expect(source).toMatch(/ReadRegStr[^\n]*DisplayVersion[\s\S]*VersionCompare[\s\S]*Downgrade is not allowed/u)
    expect(source).toMatch(/DesktopShortcut[\s\S]*StartMenuShortcut[\s\S]*LaunchAtLogin/u)
    expect(source).toMatch(/RandomNumberGenerator.*Create[\s\S]*GetBytes\(\$\$b\)[\s\S]*Dispose/u)
    expect(source).toMatch(/TrimEnd\('='\).*Replace\('\+'\s*,\s*'-'\).*Replace\('\/'\s*,\s*'_'/u)
    expect(source).toMatch(/Console\]::Out\.Write\(\$\$token\)/u)
    expect(source).toMatch(/DSH_UNINSTALL_CLEANUP_TOKEN[\s\S]*--uninstall-delete-user-data=\$DshCleanupToken/u)
    expect(source).toMatch(/SetEnvironmentVariableW[\s\S]*DSH_UNINSTALL_CLEANUP_TOKEN[\s\S]*0\)/u)
    expect(source).toMatch(/ExecWait[\s\S]*MB_RETRYCANCEL/u)
    expect(source).toMatch(/--installer-request-close[\s\S]*MB_RETRYCANCEL/u)
    expect(source).toMatch(/OpenMutexW[\s\S]*DeepSeekHarnessDesktop-5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478/u)
    expect(source).not.toMatch(/taskkill|Stop-Process|KILL_PROCESS/iu)
  })
})

describe('installer build boundary', () => {
  it('uses the pinned config and x64 NSIS target without putting secrets in argv', () => {
    const invocation = electronBuilderInvocation()
    expect(invocation.args).toEqual([
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--win', 'nsis', '--x64', '--publish', 'never',
    ])
    expect(invocation.args.join(' ')).not.toMatch(/WIN_CSC|PASSWORD/iu)
  })

  it('accepts only the exact owned installer leaf', () => {
    expect(() => { assertInstallerOutput(join(DESKTOP_INSTALLER, 'DeepSeek-Harness-Setup-0.1.0-rc.7-x64.exe')) }).not.toThrow()
    expect(() => { assertInstallerOutput(join(DESKTOP_INSTALLER, 'other.exe')) }).toThrow(/unexpected installer/u)
    expect(() => { assertInstallerOutput(join(REPOSITORY_ROOT, 'other.exe')) }).toThrow(/outside/u)
  })

  it('ships a multi-image Windows icon with common dimensions', async () => {
    const icon = await readFile(join(REPOSITORY_ROOT, 'apps/desktop/build/icon.ico'))
    expect(parseIcoDimensions(icon)).toEqual(expect.arrayContaining([16, 32, 48, 256]))
  })
})
