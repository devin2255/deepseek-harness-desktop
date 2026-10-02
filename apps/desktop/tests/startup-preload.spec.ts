import { beforeEach, describe, expect, it, vi } from 'vitest'

const exposedBridge = vi.hoisted(() => ({ value: undefined as unknown }))
const listeners = vi.hoisted(() => new Map<string, (event: unknown, state: unknown) => void>())
const exposeInMainWorld = vi.hoisted(() => vi.fn((_name: string, value: unknown) => {
  exposedBridge.value = value
}))
const invoke = vi.hoisted(() => vi.fn((_channel: string) => Promise.resolve()))
const on = vi.hoisted(() => vi.fn((channel: string, listener: (event: unknown, state: unknown) => void) => {
  listeners.set(channel, listener)
}))
const removeListener = vi.hoisted(() => vi.fn((channel: string, listener: (event: unknown, state: unknown) => void) => {
  if (listeners.get(channel) === listener) listeners.delete(channel)
}))

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}))

describe('startup preload', () => {
  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockClear()
    invoke.mockClear()
    on.mockClear()
    removeListener.mockClear()
    listeners.clear()
    exposedBridge.value = undefined
  })

  it('exposes exactly the frozen startup bridge', async () => {
    await import('../src/startup-preload.ts')

    expect(exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(exposeInMainWorld.mock.calls[0]?.[0]).toBe('deepseekStartup')
    expect(Object.isFrozen(exposedBridge.value)).toBe(true)
    expect(Object.keys(exposedBridge.value as object)).toEqual(['onState', 'retry', 'openLogs', 'exit'])
  })

  it('forwards only startup state and returns an idempotent listener disposer', async () => {
    await import('../src/startup-preload.ts')
    const bridge = startupBridge()
    const listener = vi.fn()

    const dispose = bridge.onState(listener)
    listeners.get('dsh-startup:state')?.({ sender: 'not exposed' }, {
      attempt: 1,
      phase: 'loading-runtime',
      status: 'working',
    })
    dispose()
    dispose()

    expect(listener).toHaveBeenCalledWith({ attempt: 1, phase: 'loading-runtime', status: 'working' })
    expect(removeListener).toHaveBeenCalledTimes(1)
  })

  it('maps each action to its fixed IPC channel', async () => {
    await import('../src/startup-preload.ts')
    const bridge = startupBridge()

    await bridge.retry()
    await bridge.openLogs()
    await bridge.exit()

    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'dsh-startup:retry',
      'dsh-startup:open-logs',
      'dsh-startup:exit',
    ])
  })
})

interface StartupBridgeFixture {
  readonly onState: (listener: (state: unknown) => void) => () => void
  readonly retry: () => Promise<void>
  readonly openLogs: () => Promise<void>
  readonly exit: () => Promise<void>
}

function startupBridge(): StartupBridgeFixture {
  const value = exposedBridge.value
  if (typeof value !== 'object' || value === null || !('onState' in value)) {
    throw new Error('Expected startup bridge')
  }
  return value as StartupBridgeFixture
}
