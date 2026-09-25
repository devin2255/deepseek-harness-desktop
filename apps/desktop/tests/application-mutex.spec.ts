import { describe, expect, it, vi } from 'vitest'
import { acquirePlatformApplicationMutex, applicationMutexPowerShell } from '../src/application-mutex.ts'

describe('application mutex helper', () => {
  it('owns the stable per-user mutex until stdin closes and releases it explicitly', () => {
    const script = applicationMutexPowerShell()
    expect(script).toContain('Local\\DeepSeekHarnessDesktop-5e7c4c1c-7429-5bb9-9c22-4e1bf4e2e478')
    expect(script).toMatch(/createdNew[\s\S]*exit 2/u)
    expect(script).toMatch(/ReadToEnd[\s\S]*ReleaseMutex\(\)[\s\S]*Dispose\(\)/u)
  })

  it('uses the Windows helper only where the installer requires its stable mutex', async () => {
    const release = vi.fn(async () => {})
    const acquireWindows = vi.fn(async () => ({ release }))

    for (const platform of ['darwin', 'linux'] as const) {
      const handle = await acquirePlatformApplicationMutex(platform, acquireWindows)
      await handle.release()
    }
    expect(acquireWindows).not.toHaveBeenCalled()

    const windowsHandle = await acquirePlatformApplicationMutex('win32', acquireWindows)
    expect(acquireWindows).toHaveBeenCalledOnce()
    await windowsHandle.release()
    expect(release).toHaveBeenCalledOnce()
  })
})
