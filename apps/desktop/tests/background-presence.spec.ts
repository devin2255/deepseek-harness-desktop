import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createBackgroundPresence,
  type BackgroundMenuItem,
  type BackgroundNotification,
  type BackgroundPresenceNative,
  type BackgroundTray,
} from '../src/background-presence.ts'
import type { TaskObserver, TaskObserverState } from '../src/task-observer.ts'
import type { DesktopUpdates, DesktopUpdateState } from '../src/desktop-updates.ts'

const sessionId = (value: string) => value as SessionId
const liveState = (overrides: Partial<TaskObserverState> = {}): TaskObserverState => ({
  activeTaskCount: 2,
  activeAgentCount: 3,
  attentionCount: 1,
  notifications: [],
  freshness: 'live',
  ...overrides,
})

function addListener<Event extends string>(
  listenersByEvent: Map<Event, Set<() => void>>,
  event: Event,
  listener: () => void,
): void {
  const listeners = listenersByEvent.get(event) ?? new Set()
  listeners.add(listener)
  listenersByEvent.set(event, listeners)
}

class FakeTray implements BackgroundTray {
  readonly listeners = new Map<'click' | 'double-click', Set<() => void>>()
  readonly toolTips: string[] = []
  readonly menus: unknown[] = []
  readonly destroy = vi.fn()
  setToolTip(value: string): void { this.toolTips.push(value) }
  setContextMenu(menu: unknown): void { this.menus.push(menu) }
  on(event: 'click' | 'double-click', listener: () => void): void {
    const listeners = this.listeners.get(event) ?? new Set()
    listeners.add(listener)
    this.listeners.set(event, listeners)
  }
  removeListener(event: 'click' | 'double-click', listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }
  emit(event: 'click' | 'double-click'): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
}

class FakeNotification implements BackgroundNotification {
  readonly listeners = new Map<'click' | 'close', Set<() => void>>()
  readonly show = vi.fn()
  on(event: 'click' | 'close', listener: () => void): void {
    addListener(this.listeners, event, listener)
  }
  removeListener(event: 'click' | 'close', listener: () => void): void {
    this.listeners.get(event)?.delete(listener)
  }
  emit(event: 'click' | 'close'): void {
    for (const listener of this.listeners.get(event) ?? []) listener()
  }
  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }
}

function fixture(options: {
  readonly locale?: string
  readonly platform?: NodeJS.Platform
  readonly observerDispose?: () => Promise<void>
  readonly openSession?: (id?: SessionId) => Promise<void>
  readonly reportFailure?: (error: unknown) => void
  readonly requestQuit?: () => void
  readonly updates?: Pick<DesktopUpdates, 'currentState' | 'subscribe' | 'check' | 'install'>
  readonly configureNotification?: (notification: FakeNotification, index: number) => void
} = {}) {
  const tray = new FakeTray()
  const notifications: Array<{
    readonly options: { readonly title: string; readonly body: string }
    readonly native: FakeNotification
  }> = []
  const templates: Array<readonly BackgroundMenuItem[]> = []
  let onState: ((state: TaskObserverState) => void) | undefined
  let reportError: ((error: unknown) => void) | undefined
  const disposeObserver = vi.fn(options.observerDispose ?? (async () => {}))
  const observer: TaskObserver = { dispose: disposeObserver }
  const createTray = vi.fn((_iconPath: string): BackgroundTray => tray)
  const buildMenu = vi.fn((template: readonly BackgroundMenuItem[]): unknown => {
    templates.push(template)
    return template
  })
  const createNotification = vi.fn((notificationOptions: { readonly title: string; readonly body: string }) => {
    const notification = new FakeNotification()
    options.configureNotification?.(notification, notifications.length)
    notifications.push({ options: notificationOptions, native: notification })
    return notification
  })
  const native: BackgroundPresenceNative = {
    locale: options.locale ?? 'en-US',
    platform: options.platform ?? 'win32',
    createTray,
    buildMenu,
    createNotification,
  }
  const openSession = vi.fn(options.openSession ?? (async (_id?: SessionId) => {}))
  const requestQuit = vi.fn(options.requestQuit ?? (() => {}))
  const reportFailure = vi.fn(options.reportFailure ?? (() => {}))
  const presence = createBackgroundPresence({
    native,
    ...(options.updates === undefined ? {} : { updates: options.updates }),
    assets: { windowsIconPath: 'tray.ico', macTemplateIconPath: 'trayTemplate.png' },
    actions: { openSession, requestQuit, reportFailure },
    createObserver(callbacks) {
      onState = callbacks.onState
      reportError = callbacks.reportError
      return observer
    },
  })
  return {
    createNotification, createTray, disposeObserver, tray, templates, notifications, presence,
    openSession, requestQuit, reportFailure,
    emit: (state: TaskObserverState) => { onState?.(state) },
    observerError: (error: unknown) => reportError?.(error),
  }
}

describe('background presence', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('offers signed update checks and a ready-to-install notification without stopping tasks implicitly', async () => {
    let updateState: DesktopUpdateState = { kind: 'idle' }
    let publishUpdate: ((state: DesktopUpdateState) => void) | undefined
    const check = vi.fn(async () => {})
    const install = vi.fn(async () => {})
    const updates = {
      currentState: () => updateState,
      subscribe(listener: (state: DesktopUpdateState) => void) {
        publishUpdate = (state: DesktopUpdateState) => { updateState = state; listener(state) }
        listener(updateState)
        return () => { publishUpdate = undefined }
      },
      check,
      install,
    }
    const f = fixture({ updates })
    f.emit(liveState())
    const checkItem = f.templates.at(-1)?.find(item => item.label === 'Check for Updates')
    checkItem?.click?.()
    await vi.waitFor(() => { expect(check).toHaveBeenCalledOnce() })

    publishUpdate?.({ kind: 'ready', version: '0.1.1' })
    expect(f.notifications.at(-1)?.options).toEqual({
      title: 'DeepSeek Harness update ready',
      body: 'Version 0.1.1 is downloaded. Click to review installation.',
    })
    expect(f.templates.at(-1)?.some(item => item.label === 'Install update 0.1.1…')).toBe(true)
    expect(install).not.toHaveBeenCalled()
    f.notifications.at(-1)?.native.emit('click')
    await vi.waitFor(() => { expect(install).toHaveBeenCalledOnce() })
    await f.presence.dispose()
    expect(publishUpdate).toBeUndefined()
  })

  it('owns one Windows tray with localized live summary and native actions', async () => {
    const f = fixture()
    expect(f.createTray).toHaveBeenCalledOnce()
    expect(f.createTray).toHaveBeenCalledWith('tray.ico')
    expect(f.presence.currentState()).toEqual(expect.objectContaining({
      activeTaskCount: 0,
      freshness: 'unavailable',
    }))

    const state = liveState()
    f.emit(state)
    expect(f.presence.currentState()).toBe(state)
    expect(f.tray.toolTips.at(-1)).toBe('2 tasks running · 3 agents · 1 needs attention')
    const menu = f.templates.at(-1)!
    expect(menu.map(item => item.label ?? item.type)).toEqual([
      '2 tasks running · 3 agents · 1 needs attention',
      'separator',
      'Open DeepSeek Harness',
      'Quit',
    ])
    menu[2]!.click?.()
    menu[3]!.click?.()
    await vi.waitFor(() => { expect(f.openSession).toHaveBeenCalledOnce() })
    await new Promise(resolve => setTimeout(resolve, 0))
    f.tray.emit('double-click')
    await vi.waitFor(() => { expect(f.openSession).toHaveBeenCalledTimes(2) })
    expect(f.openSession).toHaveBeenNthCalledWith(1)
    expect(f.openSession).toHaveBeenNthCalledWith(2)
    expect(f.requestQuit).toHaveBeenCalledOnce()
    await f.presence.dispose()
  })

  it('uses macOS template art and Chinese unavailable copy', async () => {
    const f = fixture({ locale: 'zh-CN', platform: 'darwin' })
    expect(f.createTray).toHaveBeenCalledWith('trayTemplate.png')
    f.emit(liveState())
    expect(f.tray.toolTips.at(-1)).toBe('2 个任务运行中 · 3 个 Agent · 1 项待处理')
    f.emit(liveState({ freshness: 'unavailable' }))
    expect(f.tray.toolTips.at(-1)).toBe('任务状态暂不可用')
    expect(f.templates.at(-1)?.map(item => item.label ?? item.type)).toEqual([
      '任务状态暂不可用',
      'separator',
      '打开 DeepSeek Harness',
      '退出',
    ])
    await f.presence.dispose()
  })

  it('creates notifications only from observer transitions and routes the exact owner', async () => {
    const f = fixture()
    f.emit(liveState({ activeTaskCount: 4, attentionCount: 2 }))
    expect(f.notifications).toHaveLength(0)

    f.emit(liveState({
      notifications: [{
        key: '1:root:attention:ask',
        kind: 'attention',
        taskId: sessionId('root'),
        ownerSessionId: sessionId('child'),
        title: 'Ship release',
        body: 'Need approval',
      }],
    }))
    expect(f.notifications).toHaveLength(1)
    expect(f.notifications[0]?.options).toEqual({ title: 'Ship release', body: 'Need approval' })
    expect(f.notifications[0]?.native.show).toHaveBeenCalledOnce()
    f.notifications[0]?.native.emit('click')
    await vi.waitFor(() => { expect(f.openSession).toHaveBeenCalledWith(sessionId('child')) })
    await f.presence.dispose()
  })

  it('contains observer, native, action, and failure-reporter exceptions', async () => {
    const f = fixture({
      reportFailure: () => { throw new Error('reporter failed') },
      requestQuit: () => { throw new Error('quit failed') },
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(f.tray, 'setToolTip').mockImplementation(() => { throw new Error('tooltip failed') })
    vi.spyOn(f.tray, 'setContextMenu').mockImplementation(() => { throw new Error('menu failed') })
    f.createNotification.mockImplementationOnce(() => { throw new Error('notification failed') })
    vi.mocked(f.openSession).mockRejectedValue(new Error('open failed'))
    expect(() => f.observerError(new Error('observer failed'))).not.toThrow()
    expect(() => {
      f.emit(liveState({
        notifications: [{
          key: 'failed', kind: 'failed', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
          title: 'Task', body: 'Failed',
        }],
      }))
    }).not.toThrow()
    expect(() => { f.tray.emit('click') }).not.toThrow()
    expect(() => { f.templates.at(-1)?.[3]?.click?.() }).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.reportFailure).toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
    await f.presence.dispose()
  })

  it('contains synchronous open failures and ignores retained quit callbacks after disposal', async () => {
    const openFailure = new Error('synchronous open failed')
    const f = fixture({ openSession: () => { throw openFailure } })
    f.emit(liveState())
    const retainedQuit = f.templates.at(-1)?.[3]?.click

    expect(() => { f.tray.emit('click') }).not.toThrow()
    expect(f.reportFailure).toHaveBeenCalledWith(openFailure)
    await f.presence.dispose()
    retainedQuit?.()
    expect(f.requestQuit).not.toHaveBeenCalled()
  })

  it('blocks late callbacks, removes listeners, awaits observer quiescence, and destroys once', async () => {
    let release!: () => void
    const f = fixture({ observerDispose: () => new Promise<void>((resolve) => { release = resolve }) })
    f.emit(liveState({
      notifications: [{
        key: 'complete', kind: 'complete', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
        title: 'Task', body: 'Ready',
      }],
    }))
    const notification = f.notifications[0]!.native
    const lateOpen = [...f.tray.listeners.get('click')!][0]!
    const first = f.presence.dispose()
    const second = f.presence.dispose()
    expect(f.tray.listeners.get('click')).toHaveLength(0)
    expect(f.tray.listeners.get('double-click')).toHaveLength(0)
    expect(notification.listenerCount()).toBe(0)
    expect(() => { lateOpen() }).not.toThrow()
    expect(() => f.observerError(new Error('late observer failure'))).not.toThrow()
    f.emit(liveState({
      notifications: [{
        key: 'late', kind: 'failed', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
        title: 'Task', body: 'Failed',
      }],
    }))
    expect(f.notifications).toHaveLength(1)
    expect(f.tray.destroy).not.toHaveBeenCalled()
    release()
    await Promise.all([first, second])
    expect(f.disposeObserver).toHaveBeenCalledOnce()
    expect(f.tray.destroy).toHaveBeenCalledOnce()
    await f.presence.dispose()
    expect(f.tray.destroy).toHaveBeenCalledOnce()
  })

  it('releases tray listeners if observer construction fails', () => {
    const tray = new FakeTray()
    const native: BackgroundPresenceNative = {
      locale: 'en-US',
      platform: 'win32',
      createTray: () => tray,
      buildMenu: template => template,
      createNotification: () => new FakeNotification(),
    }
    expect(() => createBackgroundPresence({
      native,
      assets: { windowsIconPath: 'tray.ico', macTemplateIconPath: 'trayTemplate.png' },
      actions: { openSession: async () => {}, requestQuit: () => {}, reportFailure: () => {} },
      createObserver: () => { throw new Error('observer construction failed') },
    })).toThrow('observer construction failed')
    expect(tray.listeners.get('click')).toHaveLength(0)
    expect(tray.listeners.get('double-click')).toHaveLength(0)
    expect(tray.destroy).toHaveBeenCalledOnce()
  })

  it('releases the first tray listener if second-listener registration fails', () => {
    const tray = new FakeTray()
    const registrationFailure = new Error('double-click registration failed')
    const originalOn = tray.on.bind(tray)
    vi.spyOn(tray, 'on').mockImplementation((event, listener) => {
      if (event === 'double-click') throw registrationFailure
      originalOn(event, listener)
    })
    const native: BackgroundPresenceNative = {
      locale: 'en-US',
      platform: 'win32',
      createTray: () => tray,
      buildMenu: template => template,
      createNotification: () => new FakeNotification(),
    }
    expect(() => createBackgroundPresence({
      native,
      assets: { windowsIconPath: 'tray.ico', macTemplateIconPath: 'trayTemplate.png' },
      actions: { openSession: async () => {}, requestQuit: () => {}, reportFailure: () => {} },
      createObserver: () => ({ dispose: async () => {} }),
    })).toThrow(registrationFailure)
    expect(tray.listeners.get('click')).toHaveLength(0)
    expect(tray.destroy).toHaveBeenCalledOnce()
  })

  it('attempts every teardown step and returns one stable aggregate failure', async () => {
    const firstFailure = new Error('click removal failed')
    const secondFailure = new Error('double-click removal failed')
    const notificationClickFailure = new Error('notification click removal failed')
    const notificationCloseFailure = new Error('notification close removal failed')
    const observerFailure = new Error('observer dispose failed')
    const destroyFailure = new Error('tray destroy failed')
    const f = fixture({ observerDispose: async () => { throw observerFailure } })
    f.emit(liveState({
      notifications: [{
        key: 'complete', kind: 'complete', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
        title: 'Task', body: 'Ready',
      }],
    }))
    const notification = f.notifications[0]!.native
    const removeNotification = vi.spyOn(notification, 'removeListener').mockImplementation((event) => {
      throw event === 'click' ? notificationClickFailure : notificationCloseFailure
    })
    const removed: string[] = []
    vi.spyOn(f.tray, 'removeListener').mockImplementation((event) => {
      removed.push(event)
      throw event === 'click' ? firstFailure : secondFailure
    })
    f.tray.destroy.mockImplementation(() => { throw destroyFailure })

    const first = f.presence.dispose()
    const second = f.presence.dispose()
    await expect(first).rejects.toMatchObject({
      errors: [
        firstFailure,
        secondFailure,
        notificationClickFailure,
        notificationCloseFailure,
        observerFailure,
        destroyFailure,
      ],
    })
    await expect(second).rejects.toBeInstanceOf(AggregateError)
    expect(removed).toEqual(['click', 'double-click'])
    expect(removeNotification).toHaveBeenCalledTimes(2)
    expect(f.disposeObserver).toHaveBeenCalledOnce()
    expect(f.tray.destroy).toHaveBeenCalledOnce()
    await expect(f.presence.dispose()).rejects.toBeInstanceOf(AggregateError)
    expect(removeNotification).toHaveBeenCalledTimes(2)
    expect(f.disposeObserver).toHaveBeenCalledOnce()
    expect(f.tray.destroy).toHaveBeenCalledOnce()
  })

  it('releases every notification listener after click or close and forgets settled notifications', async () => {
    const f = fixture()
    f.emit(liveState({
      notifications: [
        {
          key: 'complete', kind: 'complete', taskId: sessionId('root'), ownerSessionId: sessionId('first'),
          title: 'First', body: 'Ready',
        },
        {
          key: 'attention', kind: 'attention', taskId: sessionId('root'), ownerSessionId: sessionId('second'),
          title: 'Second', body: 'Needs input',
        },
      ],
    }))
    const [first, second] = f.notifications.map(notification => notification.native)
    const firstRemove = vi.spyOn(first!, 'removeListener')
    const secondRemove = vi.spyOn(second!, 'removeListener')
    expect(first?.listenerCount()).toBe(2)
    expect(second?.listenerCount()).toBe(2)

    first?.emit('click')
    second?.emit('close')
    await vi.waitFor(() => { expect(f.openSession).toHaveBeenCalledOnce() })
    expect(f.openSession).toHaveBeenCalledWith(sessionId('first'))
    expect(first?.listenerCount()).toBe(0)
    expect(second?.listenerCount()).toBe(0)
    expect(firstRemove).toHaveBeenCalledTimes(2)
    expect(secondRemove).toHaveBeenCalledTimes(2)

    await f.presence.dispose()
    expect(firstRemove).toHaveBeenCalledTimes(2)
    expect(secondRemove).toHaveBeenCalledTimes(2)
  })

  it('rolls back installed notification listeners when registration or show fails', async () => {
    const registrationFailure = new Error('close registration failed')
    const showFailure = new Error('show failed')
    const f = fixture({
      configureNotification(notification, index) {
        if (index === 0) {
          const originalOn = notification.on.bind(notification)
          vi.spyOn(notification, 'on').mockImplementation((event, listener) => {
            if (event === 'close') throw registrationFailure
            originalOn(event, listener)
          })
        } else {
          notification.show.mockImplementation(() => { throw showFailure })
        }
      },
    })
    f.emit(liveState({
      notifications: [
        {
          key: 'failed-registration', kind: 'failed', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
          title: 'Registration', body: 'Failed',
        },
        {
          key: 'failed-show', kind: 'failed', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
          title: 'Show', body: 'Failed',
        },
      ],
    }))

    expect(f.notifications[0]?.native.listenerCount()).toBe(0)
    expect(f.notifications[0]?.native.show).not.toHaveBeenCalled()
    expect(f.notifications[1]?.native.listenerCount()).toBe(0)
    expect(f.reportFailure).toHaveBeenCalledWith(registrationFailure)
    expect(f.reportFailure).toHaveBeenCalledWith(showFailure)
    await f.presence.dispose()
  })

  it('contains click and close cleanup failures and makes settled callbacks inert', async () => {
    const clickCleanupFailure = new Error('click cleanup failed')
    const closeCleanupFailure = new Error('close cleanup failed')
    const f = fixture()
    f.emit(liveState({
      notifications: [
        {
          key: 'click', kind: 'complete', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
          title: 'Click', body: 'Ready',
        },
        {
          key: 'close', kind: 'attention', taskId: sessionId('root'), ownerSessionId: sessionId('root'),
          title: 'Close', body: 'Ready',
        },
      ],
    }))
    const [clicked, closed] = f.notifications.map(notification => notification.native)
    const retainedClick = [...clicked!.listeners.get('click')!][0]!
    vi.spyOn(clicked!, 'removeListener').mockImplementation(() => { throw clickCleanupFailure })
    vi.spyOn(closed!, 'removeListener').mockImplementation(() => { throw closeCleanupFailure })

    expect(() => { retainedClick() }).not.toThrow()
    expect(() => { retainedClick() }).not.toThrow()
    expect(() => { closed?.emit('close') }).not.toThrow()
    expect(f.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ cause: clickCleanupFailure }))
    expect(f.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ cause: closeCleanupFailure }))
    await f.presence.dispose()
  })

  it('coalesces overlapping native activations but permits a later activation', async () => {
    let releaseFirst!: () => void
    const f = fixture({
      openSession: () => new Promise<void>((resolve) => { releaseFirst = resolve }),
    })

    f.tray.emit('click')
    f.tray.emit('double-click')
    expect(f.openSession).toHaveBeenCalledOnce()

    releaseFirst()
    await new Promise(resolve => setTimeout(resolve, 0))
    f.tray.emit('click')
    expect(f.openSession).toHaveBeenCalledTimes(2)
    await f.presence.dispose()
  })
})
