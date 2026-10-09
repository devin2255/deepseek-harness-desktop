import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/index.ts'

describe('local Task review configuration', () => {
  it('resolves omitted and explicit limits without allowing a partial patch bound', () => {
    const defaults = resolveConfig({})
    expect(defaults.gitCommand).toBe('git')
    expect(defaults.commandTimeoutMs).toBeGreaterThan(0)
    expect(defaults.terminateGraceMs).toBeGreaterThan(0)
    expect(defaults.maxOutputBytes).toBeGreaterThanOrEqual(defaults.maxDiffBytes)
    expect(defaults.maxOutputBytes).toBeGreaterThanOrEqual(defaults.maxPatchBytes)
    expect(defaults.maxFiles).toBeGreaterThan(0)
    expect(defaults.maxIntegrationInputs).toBe(16)
    expect(resolveConfig({ maxIntegrationInputs: 2 }).maxIntegrationInputs).toBe(2)
    for (const maxIntegrationInputs of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveConfig({ maxIntegrationInputs })).toThrow('maxIntegrationInputs must be a positive safe integer')
    }
    expect(resolveConfig({
      gitCommand: 'git-custom', commandTimeoutMs: 10, terminateGraceMs: 20,
      maxOutputBytes: 100, maxDiffBytes: 50, maxPatchBytes: 60, maxFiles: 3,
    })).toMatchObject({
      gitCommand: 'git-custom', commandTimeoutMs: 10, terminateGraceMs: 20,
      maxOutputBytes: 100, maxDiffBytes: 50, maxPatchBytes: 60, maxFiles: 3,
    })
    expect(() => resolveConfig({ gitCommand: ' git ' })).toThrow('gitCommand must be non-empty and normalized')
    expect(() => resolveConfig({ maxOutputBytes: 10, maxDiffBytes: 11, maxPatchBytes: 5 }))
      .toThrow('diff and patch limits must not exceed maxOutputBytes')
    expect(() => resolveConfig({ maxOutputBytes: 10, maxDiffBytes: 5, maxPatchBytes: 11 }))
      .toThrow('diff and patch limits must not exceed maxOutputBytes')
  })
})
