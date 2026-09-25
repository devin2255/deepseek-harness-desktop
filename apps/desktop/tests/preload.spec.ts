import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_OPEN_SESSION_CHANNEL,
  DESKTOP_SESSION_ID_MAX_CODE_UNITS,
} from '../src/desktop-ipc.ts'

const exposedBridge = vi.hoisted(() => ({ value: undefined as unknown }))
const ipc = vi.hoisted(() => {
  const listeners = new Map<string, Set<(event: unknown, value: unknown) => void>>()
  return {
    listeners,
    on: vi.fn((channel: string, listener: (event: unknown, value: unknown) => void) => {
      const registered = listeners.get(channel) ?? new Set()
      registered.add(listener)
      listeners.set(channel, registered)
    }),
    emit(channel: string, value: unknown) {
      for (const listener of listeners.get(channel) ?? []) listener({}, value)
    },
  }
})
const exposeInMainWorld = vi.hoisted(() => vi.fn((_name: string, value: unknown) => {
  exposedBridge.value = value
}))

vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld }, ipcRenderer: { on: ipc.on } }))

interface DesktopBridge {
  readonly platform: string
  readonly onOpenSession: (listener: (sessionId: SessionId) => void) => () => void
}

describe('desktop preload', () => {
  beforeEach(() => {
    vi.resetModules()
    exposeInMainWorld.mockClear()
    ipc.on.mockClear()
    ipc.listeners.clear()
    exposedBridge.value = undefined
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('exposes only a frozen platform value and one-way Session subscription', async () => {
    const bridge = await loadBridge()

    expect(exposeInMainWorld).toHaveBeenCalledWith('deepseekDesktop', bridge)
    expect(Object.isFrozen(bridge)).toBe(true)
    expect(Object.keys(bridge)).toEqual(['platform', 'onOpenSession'])
    expect(bridge.platform).toBe(process.platform)
    expect(ipc.on).toHaveBeenCalledOnce()
    expect(ipc.on).toHaveBeenCalledWith(DESKTOP_OPEN_SESSION_CHANNEL, expect.any(Function))
  })

  it('retains only the latest validated target until a subscriber exists', async () => {
    const bridge = await loadBridge()
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 'first')
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, '')
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, '   ')
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 42)
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 'x'.repeat(DESKTOP_SESSION_ID_MAX_CODE_UNITS + 1))
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 'latest')
    const received: SessionId[] = []

    bridge.onOpenSession(sessionId => received.push(sessionId))

    expect(received).toEqual(['latest'])
  })

  it('delivers future targets to every live subscriber and disposes each idempotently', async () => {
    const bridge = await loadBridge()
    const first = vi.fn()
    const second = vi.fn()
    const disposeFirst = bridge.onOpenSession(first)
    const disposeSecond = bridge.onOpenSession(second)

    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 'one')
    disposeFirst()
    disposeFirst()
    ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 'two')
    disposeSecond()

    expect(first.mock.calls).toEqual([['one']])
    expect(second.mock.calls).toEqual([['one'], ['two']])
  })

  it('rejects a non-function subscriber at the isolated preload boundary', async () => {
    const bridge = await loadBridge()
    const subscribe = bridge.onOpenSession as unknown as (listener: unknown) => unknown

    expect(() => subscribe('not a listener')).toThrow('must be a function')
  })

  it('contains one listener failure and still delivers to later subscribers', async () => {
    const bridge = await loadBridge()
    const failure = new Error('listener failed')
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.onOpenSession(() => { throw failure })
    const later = vi.fn()
    bridge.onOpenSession(later)

    expect(() => { ipc.emit(DESKTOP_OPEN_SESSION_CHANNEL, 'target') }).not.toThrow()

    expect(later).toHaveBeenCalledWith('target')
    expect(report).toHaveBeenCalledWith('Desktop Session navigation listener failed', failure)
  })
})

async function loadBridge(): Promise<DesktopBridge> {
  await import('../src/preload.ts')
  if (!isDesktopBridge(exposedBridge.value)) throw new Error('Expected the desktop preload bridge')
  return exposedBridge.value
}

/** Narrow the value returned by the mocked Electron isolation API. */
function isDesktopBridge(value: unknown): value is DesktopBridge {
  return typeof value === 'object'
    && value !== null
    && 'platform' in value
    && typeof value.platform === 'string'
    && 'onOpenSession' in value
    && typeof value.onOpenSession === 'function'
}
