import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { assertMacHost, assertUnsignedEnvironment, electronBuilderMacInvocation } from './build-macos-unsigned.ts'
import { REPOSITORY_ROOT } from './packaging-layout.ts'

describe('unsigned macOS desktop packaging', () => {
  it('targets only arm64 DMG and ZIP without changing the Windows target', () => {
    const config = yaml.load(readFileSync(join(REPOSITORY_ROOT, 'apps/desktop/electron-builder.yml'), 'utf8')) as {
      readonly mac: {
        readonly icon: string
        readonly artifactName: string
        readonly target: readonly { readonly target: string; readonly arch: readonly string[] }[]
      }
      readonly win: { readonly target: readonly { readonly target: string; readonly arch: readonly string[] }[] }
    }
    expect(config.mac.icon).toBe('icon.png')
    expect(config.mac.artifactName).toBe('DeepSeek-Harness-${version}-mac-arm64.${ext}')
    expect(config.mac.target).toEqual([
      { target: 'dmg', arch: ['arm64'] },
      { target: 'zip', arch: ['arm64'] },
    ])
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(electronBuilderMacInvocation().args).toEqual([
      'electron-builder', '--projectDir', join(REPOSITORY_ROOT, 'apps/desktop'),
      '--config', 'electron-builder.yml', '--mac', '--arm64', '--publish', 'never',
    ])
  })

  it('refuses signing credentials in the unsigned test lane', () => {
    expect(() => { assertUnsignedEnvironment({}) }).not.toThrow()
    for (const name of [
      'CSC_LINK', 'CSC_NAME', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD',
      'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE',
    ]) {
      expect(() => { assertUnsignedEnvironment({ [name]: 'present' }) }).toThrow(name)
    }
  })

  it('rejects non-Apple-Silicon hosts before modifying package output', () => {
    expect(() => { assertMacHost('darwin', 'arm64') }).not.toThrow()
    expect(() => { assertMacHost('darwin', 'x64') }).toThrow(/Apple Silicon/u)
    expect(() => { assertMacHost('win32', 'arm64') }).toThrow(/Apple Silicon/u)
  })

  it('ships a full-size PNG for the Mac application icon', () => {
    const png = readFileSync(join(REPOSITORY_ROOT, 'apps/desktop/build/icon.png'))
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(png.readUInt32BE(16)).toBe(1024)
    expect(png.readUInt32BE(20)).toBe(1024)
  })
})
