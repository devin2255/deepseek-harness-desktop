import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDesktopUpdates, type DesktopUpdateBackend, type DesktopUpdateState } from '../src/desktop-updates.ts'

function fixture() {
  const downloaded = new Set<(version: string) => void>()
  const errors = new Set<(error: Error) => void>()
  const checkForUpdates = vi.fn<DesktopUpdateBackend['checkForUpdates']>(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.1.1' },
  }))
  const downloadUpdate = vi.fn<DesktopUpdateBackend['downloadUpdate']>(async () => {
    for (const listener of downloaded) listener('0.1.1')
    return ['verified-installer.exe']
  })
  const quitAndInstall = vi.fn()
  const backend: DesktopUpdateBackend = {
    checkForUpdates,
    downloadUpdate,
    quitAndInstall,
    onDownloaded(listener) { downloaded.add(listener); return () => { downloaded.delete(listener) } },
    onError(listener) { errors.add(listener); return () => { errors.delete(listener) } },
  }
  const requestInstall = vi.fn(async (launch: () => void) => { launch(); return true })
  const reportFailure = vi.fn<(error: unknown) => void>()
  const updates = createDesktopUpdates({ backend, initialDelayMs: 10, intervalMs: 100, requestInstall, reportFailure })
  return { updates, checkForUpdates, downloadUpdate, quitAndInstall, requestInstall, reportFailure, downloaded, errors }
}

afterEach(() => { vi.useRealTimers() })

describe('desktop release updater', () => {
  it('checks, downloads, and installs only after the lifecycle approves', async () => {
    const f = fixture()
    const seen: DesktopUpdateState[] = []
    f.updates.subscribe((state) => { seen.push(state) })
    await f.updates.check()
    expect(seen.map(state => state.kind)).toEqual(['idle', 'checking', 'downloading', 'ready'])
    expect(f.downloadUpdate).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.updates.install()
    expect(f.requestInstall).toHaveBeenCalledOnce()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
    f.updates.dispose()
    expect(f.downloaded.size).toBe(0)
    expect(f.errors.size).toBe(0)
  })

  it('keeps a declined installation ready for a later explicit request', async () => {
    const f = fixture()
    f.requestInstall.mockResolvedValueOnce(false)
    await f.updates.check()
    await f.updates.install()
    expect(f.updates.currentState()).toEqual({ kind: 'ready', version: '0.1.1' })
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    await f.updates.install()
    expect(f.quitAndInstall).toHaveBeenCalledOnce()
    f.updates.dispose()
  })

  it('does not offer installation when the downloaded release differs from the checked version', async () => {
    const f = fixture()
    f.downloadUpdate.mockImplementationOnce(async () => {
      for (const listener of f.downloaded) listener('0.1.2')
      return ['other-installer.exe']
    })
    await f.updates.check()
    expect(f.updates.currentState()).toEqual({ kind: 'error' })
    const failure = f.reportFailure.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toMatch(/differs/u)
    await f.updates.install()
    expect(f.quitAndInstall).not.toHaveBeenCalled()
    f.updates.dispose()
  })

  it('does not continue a check after the updater emits a failure', async () => {
    const f = fixture()
    f.checkForUpdates.mockImplementationOnce(async () => {
      for (const listener of f.errors) listener(new Error('release lookup failed'))
      return { isUpdateAvailable: true, updateInfo: { version: '0.1.1' } }
    })
    await f.updates.check()
    expect(f.updates.currentState()).toEqual({ kind: 'error' })
    expect(f.downloadUpdate).not.toHaveBeenCalled()
    expect(f.reportFailure).toHaveBeenCalledOnce()
    f.updates.dispose()
  })

  it('serializes manual checks and stops scheduled checks after disposal', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    f.updates.start()
    await vi.advanceTimersByTimeAsync(10)
    expect(f.updates.currentState()).toEqual({ kind: 'up-to-date' })
    expect(f.checkForUpdates).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(2)
    f.updates.dispose()
    await vi.advanceTimersByTimeAsync(500)
    expect(f.checkForUpdates).toHaveBeenCalledTimes(2)
  })
})
