/** Packed-consumer probe keeps native prebuilds while testing absent Landlock. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeWithoutLandlockPlatformPackage } from './verify-packed-install.ts'

const roots: string[] = []

function fixture(withPlatform: boolean): { root: string; platformRoot: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-packed-landlock-probe-'))
  roots.push(root)
  const entryRoot = join(root, 'node_modules', '@deepseek-ai', 'node-addon-landlock-run')
  const platformRoot = join(root, 'node_modules', '@deepseek-ai', 'node-addon-landlock-run-linux-x64')
  mkdirSync(entryRoot, { recursive: true })
  writeFileSync(join(entryRoot, 'package.json'), '{"name":"@deepseek-ai/node-addon-landlock-run"}\n')
  if (withPlatform) {
    mkdirSync(platformRoot)
    writeFileSync(join(platformRoot, 'package.json'), '{"name":"@deepseek-ai/node-addon-landlock-run-linux-x64"}\n')
  }
  return { root, platformRoot }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('packed install without the Landlock platform package', () => {
  it('hides an installed platform package during the probe and restores it', () => {
    const { root, platformRoot } = fixture(true)
    probeWithoutLandlockPlatformPackage(root, 'linux', 'x64', () => {
      expect(existsSync(platformRoot)).toBe(false)
    })
    expect(existsSync(platformRoot)).toBe(true)
  })

  it('hides both nested and hoisted copies of the platform package', () => {
    const { root, platformRoot } = fixture(true)
    const nestedRoot = join(root, 'node_modules', '@deepseek-ai', 'node-addon-landlock-run',
      'node_modules', '@deepseek-ai', 'node-addon-landlock-run-linux-x64')
    mkdirSync(nestedRoot, { recursive: true })
    writeFileSync(join(nestedRoot, 'package.json'), '{"name":"@deepseek-ai/node-addon-landlock-run-linux-x64"}\n')
    probeWithoutLandlockPlatformPackage(root, 'linux', 'x64', () => {
      expect(existsSync(nestedRoot)).toBe(false)
      expect(existsSync(platformRoot)).toBe(false)
    })
    expect(existsSync(nestedRoot)).toBe(true)
    expect(existsSync(platformRoot)).toBe(true)
  })

  it('restores the platform package when the installed-entry probe fails', () => {
    const { root, platformRoot } = fixture(true)
    expect(() => {
      probeWithoutLandlockPlatformPackage(root, 'linux', 'x64', () => {
        throw new Error('installed entry failed')
      })
    }).toThrow('installed entry failed')
    expect(existsSync(platformRoot)).toBe(true)
  })

  it('probes an install where the optional platform package is already absent', () => {
    const { root } = fixture(false)
    let probes = 0
    probeWithoutLandlockPlatformPackage(root, 'linux', 'x64', () => { probes++ })
    expect(probes).toBe(1)
  })

  it('does not apply the Linux platform probe on another platform', () => {
    const { root, platformRoot } = fixture(true)
    let probes = 0
    probeWithoutLandlockPlatformPackage(root, 'win32', 'x64', () => { probes++ })
    expect(probes).toBe(0)
    expect(existsSync(platformRoot)).toBe(true)
  })
})
