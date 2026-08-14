import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposedBridge = vi.hoisted(() => ({ value: undefined as unknown }))
const exposeInMainWorld = vi.hoisted(() => vi.fn((_name: string, value: unknown) => {
  exposedBridge.value = value
}))

vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld } }))

describe('desktop preload', () => {
  beforeEach(() => {
    exposeInMainWorld.mockClear()
    exposedBridge.value = undefined
  })

  it('exposes only frozen platform metadata through context isolation', async () => {
    await import('../src/preload.ts')

    expect(exposeInMainWorld).toHaveBeenCalledWith('deepseekDesktop', { platform: process.platform })
    if (!hasPlatform(exposedBridge.value)) throw new Error('Expected a platform-only desktop bridge')
    expect(Object.isFrozen(exposedBridge.value)).toBe(true)
    expect(Object.keys(exposedBridge.value)).toEqual(['platform'])
  })
})

/** Narrow the bridge returned by the mocked Electron boundary without trusting mock output. */
function hasPlatform(value: unknown): value is { readonly platform: string } {
  return typeof value === 'object'
    && value !== null
    && 'platform' in value
    && typeof value.platform === 'string'
}
