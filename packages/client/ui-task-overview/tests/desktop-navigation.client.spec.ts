import type { ISessions, SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopNavigation,
  resolveDesktopNavigationBridge,
  type DesktopNavigationBridge,
  type DesktopNavigationReadiness,
} from '../src/client/desktop-navigation.ts'
import { createTaskNavigation } from '../src/client/navigation.ts'

const id = (value: string) => value as SessionId

function fixture(initiallyReady = false) {
  const bridgeListeners = new Set<(sessionId: SessionId) => void>()
  const readinessListeners = new Set<() => void>()
  let ready = initiallyReady
  const bridge: DesktopNavigationBridge = {
    onOpenSession(listener) {
      bridgeListeners.add(listener)
      return () => { bridgeListeners.delete(listener) }
    },
  }
  const readiness: DesktopNavigationReadiness = {
    isReady: () => ready,
    subscribe(listener) {
      readinessListeners.add(listener)
      return () => { readinessListeners.delete(listener) }
    },
  }
  return {
    bridge,
    readiness,
    emit(sessionId: string) { for (const listener of bridgeListeners) listener(id(sessionId)) },
    setReady(value: boolean) {
      ready = value
      for (const listener of readinessListeners) listener()
    },
    bridgeListeners,
    readinessListeners,
  }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('desktop notification navigation', () => {
  it('queues only the latest early target until the authoritative catalog is ready', async () => {
    const f = fixture()
    const navigate = vi.fn(async () => {})
    const navigation = createDesktopNavigation({ bridge: f.bridge, readiness: f.readiness, navigate, showHome: vi.fn() })

    f.emit('first')
    f.emit('latest')
    expect(navigate).not.toHaveBeenCalled()
    f.setReady(true)
    await flush()

    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledWith('latest')
    expect(navigation.failure.getSnapshot()).toBeUndefined()
    navigation.dispose()
  })

  it('routes an authoritative child through the shared Task navigation controller', async () => {
    const f = fixture(true)
    let address: SubagentAddress | undefined
    const sessions = {
      list: { getSnapshot: () => ({
        byId: {
          child: { id: id('child'), origin: 'subagent', parentId: id('parent') },
          parent: { id: id('parent') },
        },
        subagentsByParent: {},
      }) },
      open: vi.fn(),
      openSubagent: vi.fn(),
      subagentAddress: vi.fn(() => address),
      refreshSubagents: vi.fn(async () => {
        address = { parentSessionId: id('parent'), childSessionId: id('child'), mode: 'continuable' }
      }),
    }
    const showConversation = vi.fn()
    const taskNavigation = createTaskNavigation(sessions as unknown as ISessions, { showConversation })
    const desktopNavigation = createDesktopNavigation({
      bridge: f.bridge,
      readiness: f.readiness,
      navigate: sessionId => taskNavigation.open(sessionId),
      showHome: vi.fn(),
    })

    f.emit('child')
    await flush()

    expect(sessions.refreshSubagents).toHaveBeenCalledWith('parent')
    expect(sessions.openSubagent).toHaveBeenCalledWith(address)
    expect(showConversation).toHaveBeenCalledOnce()
    desktopNavigation.dispose()
    taskNavigation.dispose()
  })

  it('shows only the current failure on Home and clears it on a superseding target', async () => {
    const f = fixture(true)
    const navigate = vi.fn<(sessionId: SessionId) => Promise<void>>()
    navigate.mockRejectedValueOnce(new Error('stale failure'))
      .mockRejectedValueOnce(new Error('current failure'))
      .mockResolvedValueOnce()
    const showHome = vi.fn()
    const navigation = createDesktopNavigation({ bridge: f.bridge, readiness: f.readiness, navigate, showHome })

    f.emit('stale')
    f.emit('current')
    await flush()
    expect(showHome).toHaveBeenCalledOnce()
    expect(navigation.failure.getSnapshot()).toBe('current failure')

    f.emit('success')
    expect(navigation.failure.getSnapshot()).toBeUndefined()
    await flush()
    expect(navigation.failure.getSnapshot()).toBeUndefined()
    navigation.dispose()
  })

  it('keeps non-Error navigation and Home failures readable without rejecting the dispatcher', async () => {
    const f = fixture(true)
    const navigation = createDesktopNavigation({
      bridge: f.bridge,
      readiness: f.readiness,
      navigate: vi.fn(async () => { throw 'plain navigation failure' }),
      showHome: () => { throw new Error('Home unavailable') },
    })

    f.emit('target')
    await flush()

    expect(navigation.failure.getSnapshot()).toBe('plain navigation failure\nHome unavailable')
    navigation.dispose()
  })

  it('disposes bridge and readiness subscriptions while a target is queued', async () => {
    const f = fixture()
    const navigate = vi.fn(async () => {})
    const navigation = createDesktopNavigation({ bridge: f.bridge, readiness: f.readiness, navigate, showHome: vi.fn() })
    f.emit('queued')

    navigation.dispose()
    navigation.dispose()
    f.setReady(true)
    f.emit('late')
    await flush()

    expect(f.bridgeListeners).toHaveLength(0)
    expect(f.readinessListeners).toHaveLength(0)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('rolls back the preload subscription when readiness registration fails', () => {
    const releaseBridge = vi.fn()
    const registrationFailure = new Error('readiness registration failed')
    const bridge: DesktopNavigationBridge = { onOpenSession: () => releaseBridge }

    expect(() => createDesktopNavigation({
      bridge,
      readiness: { isReady: () => false, subscribe: () => { throw registrationFailure } },
      navigate: vi.fn(async () => {}),
      showHome: vi.fn(),
    })).toThrow(registrationFailure)
    expect(releaseBridge).toHaveBeenCalledOnce()
  })

  it('reports initialization and rollback failures together', () => {
    const registrationFailure = new Error('readiness registration failed')
    const cleanupFailure = new Error('bridge cleanup failed')
    const bridge: DesktopNavigationBridge = {
      onOpenSession: () => () => { throw cleanupFailure },
    }

    expect(() => createDesktopNavigation({
      bridge,
      readiness: { isReady: () => false, subscribe: () => { throw registrationFailure } },
      navigate: vi.fn(async () => {}),
      showHome: vi.fn(),
    })).toThrow(expect.objectContaining({ errors: [registrationFailure, cleanupFailure] }))
  })

  it('attempts both subscription disposers and returns stable cleanup failures', () => {
    const bridgeFailure = new Error('bridge cleanup failed')
    const readinessFailure = new Error('readiness cleanup failed')
    const one = createDesktopNavigation({
      bridge: { onOpenSession: () => () => { throw bridgeFailure } },
      readiness: { isReady: () => false, subscribe: () => () => {} },
      navigate: vi.fn(async () => {}),
      showHome: vi.fn(),
    })
    expect(() => {
      one.dispose()
    }).toThrow(bridgeFailure)

    const both = createDesktopNavigation({
      bridge: { onOpenSession: () => () => { throw bridgeFailure } },
      readiness: { isReady: () => false, subscribe: () => () => { throw readinessFailure } },
      navigate: vi.fn(async () => {}),
      showHome: vi.fn(),
    })
    expect(() => {
      both.dispose()
    }).toThrow(expect.objectContaining({ errors: [bridgeFailure, readinessFailure] }))
  })

  it('fences retained bridge and readiness callbacks after disposal', async () => {
    let receive!: (sessionId: SessionId) => void
    let readinessChanged!: () => void
    const navigate = vi.fn(async () => {})
    const navigation = createDesktopNavigation({
      bridge: { onOpenSession: (listener) => { receive = listener; return () => {} } },
      readiness: {
        isReady: () => true,
        subscribe: (listener) => { readinessChanged = listener; return () => {} },
      },
      navigate,
      showHome: vi.fn(),
    })
    navigation.dispose()

    receive(id('late'))
    readinessChanged()
    await flush()

    expect(navigate).not.toHaveBeenCalled()
  })

  it('treats a missing preload bridge as ordinary Web composition', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'deepseekDesktop')
    try {
      Reflect.deleteProperty(globalThis, 'deepseekDesktop')
      expect(resolveDesktopNavigationBridge()).toBeUndefined()
      const subscribe = vi.fn<DesktopNavigationReadiness['subscribe']>(() => () => {})
      const navigation = createDesktopNavigation({
        bridge: undefined,
        readiness: { isReady: () => true, subscribe },
        navigate: vi.fn(async () => {}),
        showHome: vi.fn(),
      })
      expect(subscribe).not.toHaveBeenCalled()
      navigation.dispose()
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'deepseekDesktop')
      else Object.defineProperty(globalThis, 'deepseekDesktop', original)
    }
  })

  it('rejects a hostile preload global that omits its disposer', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'deepseekDesktop')
    try {
      Object.defineProperty(globalThis, 'deepseekDesktop', {
        configurable: true,
        value: { onOpenSession: () => undefined },
      })
      const bridge = resolveDesktopNavigationBridge()
      expect(() => bridge?.onOpenSession(() => {})).toThrow('did not return a disposer')
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'deepseekDesktop')
      else Object.defineProperty(globalThis, 'deepseekDesktop', original)
    }
  })

  it.each([null, {}, { onOpenSession: 42 }])('rejects an invalid preload candidate %j', (candidate) => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'deepseekDesktop')
    try {
      Object.defineProperty(globalThis, 'deepseekDesktop', { configurable: true, value: candidate })
      expect(resolveDesktopNavigationBridge()).toBeUndefined()
    } finally {
      if (original === undefined) Reflect.deleteProperty(globalThis, 'deepseekDesktop')
      else Object.defineProperty(globalThis, 'deepseekDesktop', original)
    }
  })
})
