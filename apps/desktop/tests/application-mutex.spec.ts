import { describe, expect, it } from 'vitest'
import { applicationMutexPowerShell } from '../src/application-mutex.ts'

describe('application mutex helper', () => {
  it('owns the stable per-user mutex until stdin closes and releases it explicitly', () => {
    const script = applicationMutexPowerShell()
    expect(script).toContain('Local\\DeepSeekHarnessDesktop-5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478')
    expect(script).toMatch(/createdNew[\s\S]*exit 2/u)
    expect(script).toMatch(/ReadToEnd[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/u)
  })
})
