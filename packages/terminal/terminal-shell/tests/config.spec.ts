import { describe, expect, it } from 'vitest'
import type { Config } from '@deepseek-ai/dsh-terminal-shell/src/config.ts'
import { resolveConfig, validateConfig } from '@deepseek-ai/dsh-terminal-shell/src/config.ts'

function config(overrides: Partial<Config> = {}): Config {
  return {
    backendType: 'shell', shell: 'bash', shellPath: '/bin/bash', shellArgs: [], rows: 40, cols: 160,
    scrollbackLines: 100, scrollbackMaxBytes: 1024, maxReadBytes: 512,
    pollIntervalMs: 10, exactProbeAfterMs: 20, idleSilenceMs: 100, handoffGraceMs: 50, timeoutMs: 1000,
    disposeGraceMs: 100,
    ...overrides,
  }
}

describe('terminal-shell config', () => {
  it('resolves Bash defaults without consulting the host platform', () => {
    const resolved = resolveConfig({})
    expect(resolved.shell).toBe('bash')
    expect(resolved.shellPath).toBe('/bin/bash')
    expect(resolved.shellArgs).toEqual(['--noprofile', '--norc', '-i'])
  })

  it('resolves controlled UTF-8 PowerShell startup and preserves explicit overrides', () => {
    const resolved = resolveConfig({ shell: 'powershell' })
    expect(resolved.shellPath).toBe('powershell.exe')
    expect(resolved.shellArgs.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand'])
    const startup = Buffer.from(resolved.shellArgs[4]!, 'base64').toString('utf16le')
    expect(startup).toContain('Remove-Module PSReadLine')
    expect(startup).toContain('[Console]::InputEncoding')
    expect(startup).toContain('[Console]::OutputEncoding')
    expect(startup).toContain("'dsh> '")
    expect(resolveConfig({ shell: 'powershell', shellPath: 'pwsh', shellArgs: [] }))
      .toMatchObject({ shellPath: 'pwsh', shellArgs: [] })
    expect(() => resolveConfig({ shellPath: '' })).toThrow('shellPath')
    expect(() => resolveConfig({ rows: 0 })).toThrow('rows')
  })

  it('accepts resolved positive bounds', () => {
    expect(() => { validateConfig(config()) }).not.toThrow()
  })

  it('rejects empty names, invalid numbers, and a read cap above retention', () => {
    expect(() => { validateConfig(config({ backendType: '' })) }).toThrow('backendType')
    expect(() => { validateConfig(config({ shellPath: '' })) }).toThrow('shellPath')
    expect(() => { validateConfig(config({ rows: 0 })) }).toThrow('rows')
    expect(() => { validateConfig(config({ rows: 1.5 })) }).toThrow('rows')
    expect(() => { validateConfig(config({ maxReadBytes: 2048 })) }).toThrow('must not exceed')
  })

  it('rejects a handoff grace shorter than one readiness poll', () => {
    expect(() => { validateConfig(config({ handoffGraceMs: 9, pollIntervalMs: 10 })) }).toThrow('handoffGraceMs must be at least pollIntervalMs')
    expect(() => { validateConfig(config({ handoffGraceMs: 10, pollIntervalMs: 10 })) }).not.toThrow()
  })
})
