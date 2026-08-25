import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import yaml from 'js-yaml'

import {
  assertInstallerOutput,
  authenticodeEnvironment,
  authenticodePowerShellCommand,
  authenticodePowerShellPath,
  authenticodeSpawnOptions,
  electronBuilderDirectoryInvocation,
  electronBuilderPrepackagedInvocation,
  parseIcoDimensions,
  signingEnvironmentKind,
  signingRequested,
  verifyGeneratedInstallerScript,
} from './build-installer.ts'
import {
  assertInstallerPowerShellCommandsFresh,
  canonicalPowerShellSource,
  parseInstallerPowerShellCommands,
  renderInstallerPowerShellCommands,
} from './generate-installer-powershell.ts'
import { DESKTOP_INSTALLER, REPOSITORY_ROOT } from './packaging-layout.ts'

interface InstallerConfig {
  readonly appId: string
  readonly productName: string
  readonly asar: boolean
  readonly artifactName: string
  readonly win: { readonly target: Array<{ readonly target: string; readonly arch: string[] }>; readonly requestedExecutionLevel: string }
  readonly nsis: Record<string, unknown>
}

interface InstallerChoices {
  readonly desktop: '0' | '1'
  readonly startMenu: '0' | '1'
  readonly login: '0' | '1'
}

function installerChoiceMatrix(source: string, persisted: Partial<InstallerChoices>): InstallerChoices {
  const body = source.match(/!macro DshInitializeChoices(?<body>[\s\S]*?)!macroend/u)?.groups?.body
  if (body === undefined) throw new Error('DshInitializeChoices macro is missing')
  const defaults: InstallerChoices = {
    desktop: body.match(/StrCpy \$DshDesktopShortcut "(?<value>[01])"/u)?.groups?.value as '0' | '1',
    startMenu: body.match(/StrCpy \$DshStartMenuShortcut "(?<value>[01])"/u)?.groups?.value as '0' | '1',
    login: body.match(/StrCpy \$DshLaunchAtLogin "(?<value>[01])"/u)?.groups?.value as '0' | '1',
  }
  const mappings = [
    ['desktop', 'DshDesktopShortcut'], ['startMenu', 'DshStartMenuShortcut'], ['login', 'DshLaunchAtLogin'],
  ] as const
  const result = { ...defaults }
  for (const [field, valueName] of mappings) {
    expect(body).toMatch(new RegExp(`ReadRegStr \\$0 HKCU "\\$\\{INSTALL_REGISTRY_KEY\\}" "${valueName}"[\\s\\S]*?\\$0 == "0"[\\s\\S]*?\\$0 == "1"`, 'u'))
    if (persisted[field] !== undefined) result[field] = persisted[field]
  }
  return result
}

const execFileAsync = promisify(execFile)

async function runRestrictedCommand(command: string, environment: NodeJS.ProcessEnv, timeout = 10_000): Promise<string> {
  const result = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-EncodedCommand', command,
  ], { env: environment, timeout })
  return result.stdout.trim()
}

async function compareSemver(installed: string, candidate: string): Promise<string> {
  return runRestrictedCommand(powerShellCommands.COMPARE_SEMVER, {
    ...process.env, DSH_INSTALLER_INSTALLED_VERSION: installed, DSH_INSTALLER_CANDIDATE_VERSION: candidate,
  })
}

async function queryInstalledProcess(target: string): Promise<string> {
  return runRestrictedCommand(powerShellCommands.QUERY_INSTALLED_PROCESS, {
    ...process.env, DSH_INSTALLER_TARGET_EXE: target,
  })
}

async function inspectShortcut(shortcut: string, target: string): Promise<string> {
  return runRestrictedCommand(powerShellCommands.INSPECT_SHORTCUT, {
    ...process.env,
    DSH_INSTALLER_SHORTCUT: shortcut,
    DSH_INSTALLER_OLD_TARGET_EXE: target,
    DSH_INSTALLER_NEW_TARGET_EXE: target,
  }, 20_000)
}

async function inspectShortcutTargets(shortcut: string, oldTarget: string, newTarget: string): Promise<string> {
  return runRestrictedCommand(powerShellCommands.INSPECT_SHORTCUT, {
    ...process.env,
    DSH_INSTALLER_SHORTCUT: shortcut,
    DSH_INSTALLER_OLD_TARGET_EXE: oldTarget,
    DSH_INSTALLER_NEW_TARGET_EXE: newTarget,
  }, 20_000)
}

const configPath = join(REPOSITORY_ROOT, 'apps/desktop/electron-builder.yml')
const includePath = join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh')
const compareSemverPath = join(REPOSITORY_ROOT, 'apps/desktop/build/compare-semver.ps1')
const queryProcessPath = join(REPOSITORY_ROOT, 'apps/desktop/build/query-installed-process.ps1')
const inspectShortcutPath = join(REPOSITORY_ROOT, 'apps/desktop/build/inspect-shortcut.ps1')
const powerShellCommandsPath = join(REPOSITORY_ROOT, 'apps/desktop/build/powershell-commands.nsh')
const powerShellCommands = parseInstallerPowerShellCommands(await readFile(powerShellCommandsPath, 'utf8'))
const desktopRequire = createRequire(join(REPOSITORY_ROOT, 'apps/desktop/package.json'))
const electronBuilderPackage = desktopRequire.resolve('electron-builder/package.json')
const appBuilderPackage = createRequire(electronBuilderPackage).resolve('app-builder-lib/package.json')
const builderTemplateRoot = join(dirname(appBuilderPackage), 'templates/nsis')

describe('Windows installer configuration', { concurrent: false }, () => {
  it('keeps every generated UTF-16LE command fresh with its canonical PowerShell owner', async () => {
    const sources = {
      COMPARE_SEMVER: await readFile(compareSemverPath, 'utf8'),
      INSPECT_SHORTCUT: await readFile(inspectShortcutPath, 'utf8'),
      QUERY_INSTALLED_PROCESS: await readFile(queryProcessPath, 'utf8'),
    }
    const generated = await readFile(powerShellCommandsPath, 'utf8')
    expect(() => { assertInstallerPowerShellCommandsFresh(generated, sources) }).not.toThrow()
    for (const [name, command] of Object.entries(parseInstallerPowerShellCommands(generated))) {
      expect(Buffer.from(command, 'base64').toString('utf16le')).toBe(canonicalPowerShellSource(sources[name as keyof typeof sources]))
    }
    expect(() => { assertInstallerPowerShellCommandsFresh(generated, { ...sources, COMPARE_SEMVER: `${sources.COMPARE_SEMVER}# stale\n` }) })
      .toThrow(/stale/u)
    expect(renderInstallerPowerShellCommands(sources)).toBe(generated)
  })
  it('pins one assisted per-user offline x64 NSIS installer without elevation', async () => {
    const config = yaml.load(await readFile(configPath, 'utf8')) as InstallerConfig
    expect(config).toMatchObject({
      appId: 'ai.deepseek.harness.desktop', productName: 'DeepSeek Harness', asar: false,
      artifactName: 'DeepSeek-Harness-Setup-${version}-x64.${ext}',
      win: { target: [{ target: 'nsis', arch: ['x64'] }], requestedExecutionLevel: 'asInvoker' },
      nsis: {
        oneClick: false, perMachine: false, allowElevation: false, packElevateHelper: false,
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
      'customInstallMode', 'customWelcomePage', 'customPageAfterChangeDir', 'customInit', 'customInstall',
      'customUnInstallSection', 'customUnInstall', 'customCheckAppRunning',
    ]))
    expect(source).toMatch(/ReadRegStr[^\n]*DisplayVersion[\s\S]*DSH_POWERSHELL_COMPARE_SEMVER[\s\S]*Downgrade is not allowed/u)
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

  it('creates fresh cleanup tokens under Restricted policy without script files', async () => {
    const source = await readFile(includePath, 'utf8')
    const encoded = source.match(/-Command "(?<command>\$\$b=New-Object byte\[\] 32;[^"\r\n]+)"`/u)?.groups?.command
    expect(encoded).toBeTypeOf('string')
    const command = (encoded ?? '').replaceAll('$$', '$')
    const run = async () => {
      const result = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', command,
      ], { timeout: 10_000 })
      return result.stdout
    }
    const first = await run()
    const second = await run()
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(second).not.toBe(first)
  })

  it('forces the real assisted install-mode callback to skip the all-users page', async () => {
    const source = await readFile(includePath, 'utf8')
    const multiUserTemplate = await readFile(join(builderTemplateRoot, 'multiUserUi.nsh'), 'utf8')
    const hook = source.match(/!macro customInstallMode(?<body>[\s\S]*?)!macroend/u)?.groups?.body
    expect(hook).toMatch(/StrCpy \$isForceCurrentInstall "1"/u)
    const hookCall = multiUserTemplate.indexOf('!insertmacro customInstallMode')
    const forcedBranch = multiUserTemplate.indexOf('${if} $isForceCurrentInstall == "1"')
    const pageCreation = multiUserTemplate.indexOf('nsDialogs::Create 1018')
    expect(hookCall).toBeGreaterThan(0)
    expect(hookCall).toBeLessThan(forcedBranch)
    expect(forcedBranch).toBeLessThan(pageCreation)
    expect(multiUserTemplate.slice(forcedBranch, pageCreation)).toMatch(/setInstallModePerUser[\s\S]*Abort/u)
  })

  it('restores persisted choices for upgrades and same-version repairs without isUpdated', async () => {
    const source = await readFile(includePath, 'utf8')
    const initialization = source.match(/!macro DshInitializeChoices[\s\S]*?!macroend/u)?.[0]
    expect(initialization).toBeTypeOf('string')
    expect(initialization ?? '').not.toContain('${isUpdated}')
    expect(installerChoiceMatrix(source, {})).toEqual({ desktop: '1', startMenu: '1', login: '0' })
    expect(installerChoiceMatrix(source, { desktop: '0', startMenu: '0', login: '1' }))
      .toEqual({ desktop: '0', startMenu: '0', login: '1' })
    expect(installerChoiceMatrix(source, { desktop: '0' }))
      .toEqual({ desktop: '0', startMenu: '1', login: '0' })
  })

  it('uses SemVer 2.0 precedence for upgrade, repair, release, and build metadata', async () => {
    await expect(compareSemver('0.1.0-rc.6', '0.1.0-rc.7')).resolves.toBe('-1')
    await expect(compareSemver('0.1.0-rc.7', '0.1.0')).resolves.toBe('-1')
    await expect(compareSemver('0.1.0-beta.9', '0.1.0-rc.1')).resolves.toBe('-1')
    await expect(compareSemver('0.1.0-rc.2', '0.1.0-rc.10')).resolves.toBe('-1')
    await expect(compareSemver('0.1.0+old', '0.1.0+new')).resolves.toBe('0')
    await expect(compareSemver('0.1.0', '0.1.0')).resolves.toBe('0')
    await expect(compareSemver('0.2.0', '0.1.0')).resolves.toBe('1')
    await expect(compareSemver('invalid', '0.1.0')).rejects.toMatchObject({ code: 2 })
    for (const contaminated of ['0.1.0\r', '0.1.0\n', '0.1.0\r\n', '0.1.0 ', '0.1.0\t']) {
      await expect(compareSemver(contaminated, '0.1.0')).rejects.toMatchObject({ code: 2 })
    }
    const source = canonicalPowerShellSource(await readFile(compareSemverPath, 'utf8'))
    const definitions = source.slice(0, source.indexOf('\ntry {'))
    const nulProbe = `${definitions}\nif ($null -eq (ConvertFrom-DshSemVer (\"0.1.0\" + [char]0))) { exit 2 }; exit 0\n`
    const nulCommand = Buffer.from(nulProbe, 'utf16le').toString('base64')
    await expect(runRestrictedCommand(nulCommand, process.env)).rejects.toMatchObject({ code: 2 })
    expect(source).toContain('\\z')
  })

  it('passes registry and candidate versions through temporary environment values only', async () => {
    const source = await readFile(includePath, 'utf8')
    expect(source).not.toContain('VersionCompare')
    expect(source).toContain('!include "${BUILD_RESOURCES_DIR}\\powershell-commands.nsh"')
    const versionChannels = new RegExp(
      String.raw`SetEnvironmentVariableW[^\n]*DSH_INSTALLER_INSTALLED_VERSION[\s\S]*`
      + String.raw`SetEnvironmentVariableW[^\n]*DSH_INSTALLER_CANDIDATE_VERSION`,
      'u',
    )
    expect(source).toMatch(versionChannels)
    expect(source).toContain('-EncodedCommand ${DSH_POWERSHELL_COMPARE_SEMVER}')
    expect(source).not.toMatch(/powershell[^\n]*-File/iu)
    expect(source.match(/SetEnvironmentVariableW[^\n]*DSH_INSTALLER_(?:INSTALLED|CANDIDATE)_VERSION[^\n]*p 0/gu)).toHaveLength(2)
    expect(source).toMatch(/SemVer is invalid[\s\S]*Quit/u)
  })

  it('queries the exact executable path without interpolating custom paths into PowerShell', async () => {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    await expect(queryInstalledProcess(powershell)).resolves.toBe('running')
    await expect(queryInstalledProcess("C:\\用户\\合法' ; exit 9; #\\DeepSeek Harness.exe")).resolves.toBe('stopped')
    await expect(queryInstalledProcess('')).rejects.toMatchObject({ code: 2 })
    const script = await readFile(queryProcessPath, 'utf8')
    expect(script).toContain('$env:DSH_INSTALLER_TARGET_EXE')
    expect(script).not.toContain('$INSTDIR')
  })

  it('checks the exact process path before treating the mutex as an additional signal', async () => {
    const source = await readFile(includePath, 'utf8')
    const hook = source.match(/!macro customCheckAppRunning(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    expect(hook.indexOf('!insertmacro DshQueryInstalledProcess')).toBeGreaterThanOrEqual(0)
    expect(hook.indexOf('!insertmacro DshQueryInstalledProcess')).toBeLessThan(hook.indexOf('OpenMutexW'))
    expect(hook).toMatch(/DshQueryFailed:[\s\S]*MB_RETRYCANCEL/u)
    expect(hook).not.toMatch(/IntCmp \$2 0 DshNotRunning/u)
    expect(source).toContain('-EncodedCommand ${DSH_POWERSHELL_QUERY_INSTALLED_PROCESS}')
    expect(source).toMatch(/DSH_INSTALLER_TARGET_EXE[\s\S]*DSH_INSTALLER_TARGET_EXE[^\n]*p 0/u)
  })

  it('treats cleanup launch errors as failure even when the exit register contains stale zero', async () => {
    const source = await readFile(includePath, 'utf8')
    const cleanup = source.slice(source.indexOf('DshCleanupAttempt:'), source.indexOf('DshCleanupSkip:'))
    expect(cleanup).toMatch(/StrCpy \$1 "0"[\s\S]*ClearErrors[\s\S]*ExecWait[^\n]*\$0\s*\n\s*IfErrors 0 \+2\s*\n\s*StrCpy \$1 "1"/u)
    const errorCheck = cleanup.indexOf('IfErrors 0 +2')
    const clearEnvironment = cleanup.indexOf('DSH_UNINSTALL_CLEANUP_TOKEN", p 0')
    const launchFailure = cleanup.indexOf('StrCmp $1 "1" DshCleanupFailed')
    const exitCheck = cleanup.indexOf('StrCmp $0 "0" DshCleanupSkip')
    expect(errorCheck).toBeLessThan(clearEnvironment)
    expect(clearEnvironment).toBeLessThan(launchFailure)
    expect(launchFailure).toBeLessThan(exitCheck)
  })

  it('recognizes only old or new exact shortcut targets through one serialized COM session', { timeout: 20_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-shortcut-'))
    const shortcut = join(directory, "用户's DeepSeek Harness.lnk")
    const windows = process.env.SystemRoot ?? 'C:\\Windows'
    const target = join(windows, 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const foreignTarget = join(windows, 'System32/cmd.exe')
    try {
      const createShortcut = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:DSH_TEST_SHORTCUT);$s.TargetPath=$env:DSH_TEST_TARGET;$s.Save()'
      await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', createShortcut], {
        env: { ...process.env, DSH_TEST_SHORTCUT: shortcut, DSH_TEST_TARGET: target },
      })
      await expect(inspectShortcut(shortcut, target)).resolves.toBe('owned')
      await expect(inspectShortcut(shortcut, foreignTarget)).resolves.toBe('foreign')
      await expect(inspectShortcut(join(directory, 'missing.lnk'), target)).resolves.toBe('missing')
      const oldTarget = join(windows, "用户's 旧目录/WindowsPowerShell/v1.0/powershell.exe")
      const newTarget = target
      for (const [target, expected] of [[oldTarget, 'owned'], [newTarget, 'owned'], [foreignTarget, 'foreign']] as const) {
        await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', createShortcut], {
          env: { ...process.env, DSH_TEST_SHORTCUT: shortcut, DSH_TEST_TARGET: target },
        })
        await expect(inspectShortcutTargets(shortcut, oldTarget, newTarget)).resolves.toBe(expected)
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('captures the old location before builder registry replacement and cleans only quoted old or new Run values', async () => {
    const source = await readFile(includePath, 'utf8')
    const installerTemplate = await readFile(join(builderTemplateRoot, 'installer.nsi'), 'utf8')
    const installSection = await readFile(join(builderTemplateRoot, 'installSection.nsh'), 'utf8')
    const init = source.match(/!macro customInit(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    const install = source.match(/!macro customInstall\s*\r?\n(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    expect(init).toMatch(/ReadRegStr \$DshOldInstallLocation HKCU "\$\{INSTALL_REGISTRY_KEY\}" "?InstallLocation"?/u)
    expect(installerTemplate.indexOf('!insertmacro customInit')).toBeLessThan(installerTemplate.indexOf('Section "install"'))
    expect(installSection.indexOf('!insertmacro registryAddInstallInfo')).toBeLessThan(installSection.indexOf('!insertmacro customInstall'))
    expect(install).toMatch(/WriteRegStr HKCU "\$\{INSTALL_REGISTRY_KEY\}" "?InstallLocation"? "\$INSTDIR"/u)
    expect(install).toContain('!insertmacro DshRemoveOwnedRunValue "$DshOldAppExe" "$appExe"')
    const runCleanup = source.match(/!macro DshRemoveOwnedRunValue OldTarget NewTarget(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    expect(runCleanup).toContain('ReadRegStr')
    expect(runCleanup).toContain('$\\"${OldTarget}$\\"')
    expect(runCleanup).toContain('$\\"${NewTarget}$\\"')
    expect(runCleanup).toContain('DeleteRegValue')
  })

  it('applies moved-path ownership cleanup for every shortcut option branch', async () => {
    const source = await readFile(includePath, 'utf8')
    const install = source.match(/!macro customInstall\s*\r?\n(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    expect(install.match(/DshRemoveOwnedShortcut[^\n]*\$DshOldAppExe[^\n]*\$appExe/gu)).toHaveLength(2)
    const desktopBranch = install.slice(
      install.indexOf('${if} $DshDesktopShortcut'),
      install.indexOf('${if} $DshStartMenuShortcut'),
    )
    const startMenuBranch = install.slice(
      install.indexOf('${if} $DshStartMenuShortcut'),
      install.indexOf('!insertmacro DshRemoveOwnedRunValue'),
    )
    for (const branch of [desktopBranch, startMenuBranch]) {
      expect(branch).toMatch(/CreateShortcut[^\n]*\$appExe/u)
      expect(branch).toMatch(/else[\s\S]*?DshRemoveOwnedShortcut[^\n]*\$DshOldAppExe[^\n]*\$appExe/u)
    }
  })

  it('launches the close helper without waiting and polls exact old process path for a fixed bound', async () => {
    const source = await readFile(includePath, 'utf8')
    const hook = source.match(/!macro customCheckAppRunning(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    expect(hook).toContain('Exec \'"$DshCloseTarget" --installer-request-close\'')
    expect(hook).not.toContain('ExecWait')
    expect(hook).toMatch(/ClearErrors[\s\S]*?Exec [^\n]*--installer-request-close[\s\S]*?IfErrors DshCloseBlocked/u)
    expect(hook).toMatch(/IntCmp \$1 \$\{DSH_CLOSE_POLL_ATTEMPTS\}/u)
    expect(hook).toContain('Sleep ${DSH_CLOSE_POLL_INTERVAL_MS}')
    expect(source).toMatch(/!define DSH_CLOSE_POLL_ATTEMPTS \d+/u)
    expect(source).toMatch(/!define DSH_CLOSE_POLL_INTERVAL_MS \d+/u)
    const installerBranchStart = hook.indexOf('!else', hook.indexOf('!ifdef BUILD_UNINSTALLER'))
    const installerBranch = hook.slice(installerBranchStart, hook.indexOf('!endif', installerBranchStart))
    const oldTarget = installerBranch.indexOf('StrCpy $DshCloseTarget "$DshOldAppExe"')
    const emptyFallback = installerBranch.indexOf('$DshOldAppExe == ""')
    const newTarget = installerBranch.indexOf('StrCpy $DshCloseTarget "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"')
    expect(oldTarget).toBeGreaterThanOrEqual(0)
    expect(oldTarget).toBeLessThan(emptyFallback)
    expect(emptyFallback).toBeLessThan(newTarget)
  })

  it('declares only the close target needed by both generated programs outside the build condition', async () => {
    const source = await readFile(includePath, 'utf8')
    const conditionalDeclarations = source.indexOf('!ifdef BUILD_UNINSTALLER')
    const closeTargetDeclaration = source.indexOf('Var DshCloseTarget')
    expect(closeTargetDeclaration).toBeGreaterThanOrEqual(0)
    expect(closeTargetDeclaration).toBeLessThan(conditionalDeclarations)
    expect(source.indexOf('Var DshOldInstallLocation')).toBeGreaterThan(conditionalDeclarations)
    expect(source.indexOf('Var DshOldAppExe')).toBeGreaterThan(conditionalDeclarations)
    const hook = source.match(/!macro customCheckAppRunning(?<body>[\s\S]*?)!macroend/u)?.groups?.body ?? ''
    expect(hook).toMatch(/!ifdef BUILD_UNINSTALLER[\s\S]*?StrCpy \$DshCloseTarget "\$INSTDIR/u)
    expect(hook).toMatch(/!else[\s\S]*?StrCpy \$DshCloseTarget "\$DshOldAppExe"/u)
  })

  it('removes shortcuts only through exact-target ownership checks', async () => {
    const source = await readFile(includePath, 'utf8')
    expect(source).toContain('!insertmacro DshRemoveOwnedShortcut "$DESKTOP\\DeepSeek Harness.lnk" "$DshOldAppExe" "$appExe"')
    expect(source).toContain('!insertmacro DshRemoveOwnedShortcut "$SMPROGRAMS\\DeepSeek Harness\\DeepSeek Harness.lnk" "$DshOldAppExe" "$appExe"')
    expect(source).not.toMatch(/Delete "\$(?:DESKTOP|SMPROGRAMS)\\DeepSeek Harness/u)
  })
})

describe('installer build boundary', () => {
  it('validates generated assisted-script ordering across host path separators', () => {
    const script = [
      '!include "/repo/apps/desktop/build/installer.nsh"',
      '!include "multiUser.nsh"',
      '!include "assistedInstaller.nsh"',
    ].join('\n')
    expect(() => { verifyGeneratedInstallerScript(yaml.dump({ nsis: { script } })) }).not.toThrow()
    const reversed = script.split('\n').reverse().join('\n')
    expect(() => { verifyGeneratedInstallerScript(yaml.dump({ nsis: { script: reversed } })) }).toThrow(/not defined before/u)
  })

  it('reuses the quarantine-and-reinspect reset for the installer leaf', async () => {
    const source = await readFile(join(REPOSITORY_ROOT, 'scripts/desktop/build-installer.ts'), 'utf8')
    expect(source).toContain('await resetStageDirectory(REPOSITORY_ROOT, DESKTOP_INSTALLER)')
    expect(source).not.toMatch(/rm\(quarantine, \{ recursive: true \}\)/u)
  })

  it('requests electron-builder final-script diagnostics without adding machine paths to configuration', async () => {
    const source = await readFile(join(REPOSITORY_ROOT, 'scripts/desktop/build-installer.ts'), 'utf8')
    expect(source).toContain("{ ...process.env, DEBUG: 'electron-builder' }")
    expect(source).toContain("verifyGeneratedInstallerScript(await readFile(join(DESKTOP_INSTALLER, 'builder-debug.yml'), 'utf8'))")
    expect(source).toContain('await validatePackage({ packageRoot: WIN_UNPACKED })')
    expect(source).toContain('await packageTreeManifest(WIN_UNPACKED)')
    expect(source).toContain('await sanitizeBundlerRegionMarkers(WIN_UNPACKED)')
    expect(source).toContain("'--prepackaged', WIN_UNPACKED")
    expect(source).not.toContain("await resetStageDirectory(REPOSITORY_ROOT, join(DESKTOP_INSTALLER, 'win-unpacked'))")
    expect(source).toContain("await removeOrdinaryBuilderFile('builder-debug.yml')")
    expect(source).toContain("await removeOrdinaryBuilderFile('latest.yml')")
    expect(await readFile(configPath, 'utf8')).not.toContain(REPOSITORY_ROOT)
  })

  it('validates the exact absolute unpacked directory later passed to NSIS', () => {
    const directory = electronBuilderDirectoryInvocation()
    const prepackaged = electronBuilderPrepackagedInvocation()
    expect(directory.args).toEqual([
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--win', '--x64', '--dir', '--publish', 'never',
    ])
    expect(prepackaged.args).toEqual([
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--win', 'nsis', '--x64', '--publish', 'never',
      '--prepackaged', join(DESKTOP_INSTALLER, 'win-unpacked'),
    ])
    expect([...directory.args, ...prepackaged.args].join(' ')).not.toMatch(/WIN_CSC|PASSWORD/iu)
  })

  it('requires a complete signing environment without exposing its values', () => {
    expect(signingRequested({})).toBe(false)
    expect(signingRequested({ WIN_CSC_LINK: 'secret', WIN_CSC_KEY_PASSWORD: 'secret' })).toBe(true)
    expect(signingRequested({ CSC_LINK: 'secret', CSC_KEY_PASSWORD: 'secret' })).toBe(true)
    expect(signingRequested({
      WIN_CSC_LINK: 'windows', WIN_CSC_KEY_PASSWORD: 'windows', CSC_LINK: 'generic', CSC_KEY_PASSWORD: 'generic',
    })).toBe(true)
    expect(signingEnvironmentKind({
      WIN_CSC_LINK: 'windows', WIN_CSC_KEY_PASSWORD: 'windows', CSC_LINK: 'generic', CSC_KEY_PASSWORD: 'generic',
    })).toBe('windows')
    expect(() => signingRequested({ WIN_CSC_LINK: 'secret' })).toThrow(/incomplete signing/u)
    expect(() => signingRequested({ WIN_CSC_KEY_PASSWORD: 'secret' })).toThrow(/incomplete signing/u)
    expect(() => signingRequested({ WIN_CSC_LINK: 'secret', CSC_LINK: 'generic', CSC_KEY_PASSWORD: 'generic' }))
      .toThrow(/incomplete signing/u)
  })

  it('passes the Authenticode artifact through a dedicated environment value', () => {
    const command = authenticodePowerShellCommand()
    expect(command).toContain('$env:DSH_SIGNATURE_ARTIFACT')
    expect(command).not.toContain('$args')
    const environment = authenticodeEnvironment('C:\\release\\setup.exe', {
      SystemRoot: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      ProgramFiles: 'C:\\Program Files',
      PSModulePath: 'C:\\bundled-powershell\\Modules',
      DSH_SECRET_SENTINEL: 'must-not-cross',
      PATH: 'C:\\secret-bin',
    })
    expect(environment).toMatchObject({
      DSH_SIGNATURE_ARTIFACT: 'C:\\release\\setup.exe',
      PSModulePath: 'C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules',
    })
    expect(environment).not.toHaveProperty('DSH_SECRET_SENTINEL')
    expect(environment).not.toHaveProperty('PATH')
    expect(authenticodePowerShellPath({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    )
    expect(authenticodeSpawnOptions('C:\\release\\setup.exe', process.env)).toMatchObject({
      timeout: 15_000, maxBuffer: 64 * 1024,
    })
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
