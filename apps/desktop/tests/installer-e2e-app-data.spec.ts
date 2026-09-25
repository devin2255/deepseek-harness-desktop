import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  configureInstallerE2eAppData,
  INSTALLER_E2E_APP_DATA_MARKER,
  INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY,
  INSTALLER_E2E_ROOT_ENVIRONMENT_KEY,
} from '../src/installer-e2e-app-data.ts'

const roots: string[] = []
const OWNERSHIP = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'win32')('installer E2E appData isolation', () => {
  it('sets appData and home only for a packaged Windows launch with matching CLI, environment, and marker', () => {
    const root = ownedRoot()
    const setPath = vi.fn()

    const arguments_ = configureInstallerE2eAppData({
      app: { getPath: () => join(tmpdir(), 'real-roaming'), isPackaged: true, setPath },
      argv: ['--installer-request-close', `--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${OWNERSHIP}`],
      environment: {
        DSH_INSTALLER_E2E: '1',
        [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
        [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: OWNERSHIP,
      },
      platform: 'win32',
    })

    expect(setPath).toHaveBeenCalledTimes(2)
    expect(setPath).toHaveBeenCalledWith('appData', join(root, 'appdata', 'roaming'))
    expect(setPath).toHaveBeenCalledWith('home', join(root, 'home'))
    expect(arguments_).toEqual(['--installer-request-close'])
  })

  it('accepts the fixture when its isolated TEMP directory is inside the owned root', () => {
    const root = ownedRoot()
    const isolatedTemp = join(root, 'temp')
    mkdirSync(isolatedTemp)
    const previousTemp = process.env.TEMP
    process.env.TEMP = isolatedTemp
    const setPath = vi.fn()
    try {
      configureInstallerE2eAppData({
        app: { getPath: () => join(tmpdir(), '..', '..', 'real-roaming'), isPackaged: true, setPath },
        argv: [`--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${OWNERSHIP}`],
        environment: {
          DSH_INSTALLER_E2E: '1',
          [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
          [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: OWNERSHIP,
          TEMP: isolatedTemp,
        },
        platform: 'win32',
      })
    } finally {
      if (previousTemp === undefined) delete process.env.TEMP
      else process.env.TEMP = previousTemp
    }
    expect(setPath).toHaveBeenCalledWith('appData', join(root, 'appdata', 'roaming'))
  })

  it.each(['missing', 'file', 'junction'] as const)('rejects a %s fixture home before changing any Electron path', (kind) => {
    const root = ownedRoot()
    const home = join(root, 'home')
    rmSync(home, { recursive: true })
    if (kind === 'file') writeFileSync(home, 'not a directory')
    if (kind === 'junction') {
      const target = join(root, 'redirect-target')
      mkdirSync(target)
      symlinkSync(target, home, 'junction')
    }
    const setPath = vi.fn()
    expect(() => configureInstallerE2eAppData({
      app: { getPath: () => join(tmpdir(), 'real-roaming'), isPackaged: true, setPath },
      argv: [`--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${OWNERSHIP}`],
      environment: {
        DSH_INSTALLER_E2E: '1',
        [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
        [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: OWNERSHIP,
      },
      platform: 'win32',
    })).toThrow(/E2E data isolation/iu)
    expect(setPath).not.toHaveBeenCalled()
  })

  it.each([
    { packaged: false, platform: 'win32', argv: true, environment: true, marker: true },
    { packaged: true, platform: 'linux', argv: true, environment: true, marker: true },
    { packaged: true, platform: 'win32', argv: false, environment: true, marker: true },
    { packaged: true, platform: 'win32', argv: true, environment: false, marker: true },
    { packaged: true, platform: 'win32', argv: true, environment: true, marker: false },
  ])('fails closed for partial or ineligible isolation input %#', ({ packaged, platform, argv, environment, marker }) => {
    const root = ownedRoot(marker)
    const setPath = vi.fn()
    expect(() =>{  configureInstallerE2eAppData({
      app: { getPath: () => join(tmpdir(), 'real-roaming'), isPackaged: packaged, setPath },
      argv: argv ? [`--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${OWNERSHIP}`] : [],
      environment: environment
        ? {
          DSH_INSTALLER_E2E: '1',
          [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
          [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: OWNERSHIP,
        }
        : {},
      platform: platform as NodeJS.Platform,
    }) }).toThrow(/E2E data isolation/iu)
    expect(setPath).not.toHaveBeenCalled()
  })

  it('does nothing when no isolation input is present', () => {
    const setPath = vi.fn()
    configureInstallerE2eAppData({
      app: { getPath: () => join(tmpdir(), 'real-roaming'), isPackaged: true, setPath },
      argv: [], environment: {}, platform: 'win32',
    })
    expect(setPath).not.toHaveBeenCalled()
  })

  it.each([
    { argument: OWNERSHIP, environment: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    { argument: 'short', environment: 'short' },
    { argument: `${OWNERSHIP}=`, environment: `${OWNERSHIP}=` },
  ])('rejects mismatched or malformed ownership proof %# without disclosing it', ({ argument, environment }) => {
    const root = ownedRoot()
    let error: Error | undefined
    try {
      configureInstallerE2eAppData({
        app: { getPath: () => join(tmpdir(), 'real-roaming'), isPackaged: true, setPath: vi.fn() },
        argv: [`--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${argument}`],
        environment: {
          DSH_INSTALLER_E2E: '1',
          [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
          [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: environment,
        },
        platform: 'win32',
      })
    } catch (caught: unknown) {
      error = caught as Error
    }
    expect(error?.message).toBe('Invalid installer E2E data isolation request')
    expect(error?.message).not.toContain(argument)
    expect(error?.message).not.toContain(environment)
  })

  it('rejects a fixture appData directory that contains the real product data root', () => {
    const root = ownedRoot()
    const candidateAppData = join(root, 'appdata', 'roaming')
    const setPath = vi.fn()
    expect(() =>{  configureInstallerE2eAppData({
      app: { getPath: () => candidateAppData, isPackaged: true, setPath },
      argv: [`--dsh-installer-e2e-root=${root}`, `--dsh-installer-e2e-ownership=${OWNERSHIP}`],
      environment: {
        DSH_INSTALLER_E2E: '1',
        [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: root,
        [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: OWNERSHIP,
      },
      platform: 'win32',
    }) }).toThrow(/E2E data isolation/iu)
    expect(setPath).not.toHaveBeenCalled()
  })

  it('rejects mismatched and redirected fixture roots', () => {
    const root = ownedRoot()
    const redirected = join(tmpdir(), `dsh-installer-e2e-link-${Date.now()}`)
    roots.push(redirected)
    mkdirSync(join(root, 'target'))
    // A junction is available without administrative symbolic-link privileges.
    symlinkSync(root, redirected, 'junction')
    const setPath = vi.fn()
    expect(() =>{  configureInstallerE2eAppData({
      app: { getPath: () => join(tmpdir(), 'real-roaming'), isPackaged: true, setPath },
      argv: [`--dsh-installer-e2e-root=${redirected}`, `--dsh-installer-e2e-ownership=${OWNERSHIP}`],
      environment: {
        DSH_INSTALLER_E2E: '1',
        [INSTALLER_E2E_ROOT_ENVIRONMENT_KEY]: redirected,
        [INSTALLER_E2E_OWNERSHIP_ENVIRONMENT_KEY]: OWNERSHIP,
      },
      platform: 'win32',
    }) }).toThrow(/E2E data isolation/iu)
    expect(setPath).not.toHaveBeenCalled()
  })
})

function ownedRoot(marker = true): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-installer-e2e-'))
  roots.push(root)
  mkdirSync(join(root, 'appdata', 'roaming'), { recursive: true })
  mkdirSync(join(root, 'home'))
  if (marker) writeFileSync(join(root, INSTALLER_E2E_APP_DATA_MARKER), `${OWNERSHIP}\n`)
  return root
}
