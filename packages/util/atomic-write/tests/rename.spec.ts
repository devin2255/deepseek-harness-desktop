/** Atomic replacement under temporary Windows sharing failures. */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '../src/index.ts'

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
const target = '/settings.yaml'

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  Object.defineProperty(process, 'platform', { value: 'win32' })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('atomic replacement retry', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries temporary %s without rewriting the sibling or deleting the destination', async (code) => {
    const failure = Object.assign(new Error('sharing violation'), { code })
    vi.mocked(rename).mockRejectedValueOnce(failure).mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    await Promise.all([
      expect(writeFileAtomic(target, 'new', { mode: 0o600 })).resolves.toBeUndefined(),
      vi.runAllTimersAsync(),
    ])

    expect(mkdir).toHaveBeenCalledOnce()
    expect(writeFile).toHaveBeenCalledOnce()
    expect(rename).toHaveBeenCalledTimes(3)
    const sibling = vi.mocked(writeFile).mock.calls[0]![0]
    expect(vi.mocked(rename).mock.calls).toEqual([[sibling, target], [sibling, target], [sibling, target]])
    expect(rm).not.toHaveBeenCalled()
  })

  it('returns the last sharing failure at the deadline and removes only its sibling', async () => {
    const failure = Object.assign(new Error('still occupied'), { code: 'EPERM' })
    vi.mocked(rename)
      .mockRejectedValueOnce(Object.assign(new Error('initial contention'), { code: 'EBUSY' }))
      .mockRejectedValue(failure)
    await Promise.all([
      expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toBe(failure),
      vi.runAllTimersAsync(),
    ])

    expect(Date.now()).toBe(1_000)
    expect(vi.mocked(rename).mock.calls.length).toBeGreaterThan(1)
    expect(writeFile).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledExactlyOnceWith(vi.mocked(writeFile).mock.calls[0]![0], { force: true })
  })

  it.each(['ENOENT', 'EIO', undefined])('rejects an unrelated %s error without retrying', async (code) => {
    const failure = Object.assign(new Error('not a sharing failure'), { code })
    vi.mocked(rename).mockRejectedValue(failure)
    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledOnce()
    expect(Date.now()).toBe(0)
    expect(rm).toHaveBeenCalledExactlyOnceWith(vi.mocked(writeFile).mock.calls[0]![0], { force: true })
  })

  it.each(['linux', 'darwin'])('does not retry permission failures on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform })
    const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' })
    vi.mocked(rename).mockRejectedValue(failure)
    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledOnce()
    expect(Date.now()).toBe(0)
  })

  it('propagates an absent failure value without retrying', async () => {
    vi.mocked(rename).mockRejectedValue(null)
    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toBeNull()
    expect(rename).toHaveBeenCalledOnce()
    expect(Date.now()).toBe(0)
  })

  it('stops retrying as soon as the failure is unrelated to sharing', async () => {
    const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' })
    vi.mocked(rename)
      .mockRejectedValueOnce(Object.assign(new Error('occupied'), { code: 'EBUSY' }))
      .mockRejectedValue(failure)
    await Promise.all([
      expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toBe(failure),
      vi.runAllTimersAsync(),
    ])
    expect(rename).toHaveBeenCalledTimes(2)
    expect(Date.now()).toBe(10)
  })

  it('does not start another rename when scheduler delay consumes the retry budget', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    const failure = Object.assign(new Error('occupied'), { code: 'EPERM' })
    vi.mocked(rename).mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const settled = writeFileAtomic(target, 'new', { mode: 0o600 })
      .then(() => undefined, (error: unknown) => error)
    await vi.advanceTimersByTimeAsync(0)
    expect(rename).toHaveBeenCalledOnce()
    clock.mockReturnValue(1_001)
    await vi.advanceTimersByTimeAsync(10)

    expect(await settled).toBe(failure)
    expect(rename).toHaveBeenCalledOnce()
    expect(rm).toHaveBeenCalledExactlyOnceWith(vi.mocked(writeFile).mock.calls[0]![0], { force: true })
  })

  it('does not wait when the failed filesystem call consumes the retry budget', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1_000)
    const failure = Object.assign(new Error('occupied'), { code: 'EPERM' })
    vi.mocked(rename).mockRejectedValue(failure)

    await expect(writeFileAtomic(target, 'new', { mode: 0o600 })).rejects.toBe(failure)
    expect(rename).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
