/** Native background-presence ownership for desktop Task activity. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TaskObserver, TaskObserverState } from './task-observer.ts'
import type { DesktopUpdates, DesktopUpdateState } from './desktop-updates.ts'

/** Application operations exposed to native background controls. */
export interface BackgroundPresenceActions {
  readonly openSession: (sessionId?: SessionId) => Promise<void>
  readonly requestQuit: () => void
  readonly reportFailure: (error: unknown) => void
}

/** Menu item understood by the Electron adapter. */
export interface BackgroundMenuItem {
  readonly label?: string
  readonly enabled?: boolean
  readonly type?: 'separator'
  readonly click?: () => void
}

/** Narrow native tray surface owned by the controller. */
export interface BackgroundTray {
  setToolTip(value: string): void
  setContextMenu(menu: unknown): void
  on(event: 'click' | 'double-click', listener: () => void): void
  removeListener(event: 'click' | 'double-click', listener: () => void): void
  destroy(): void
}

/** Narrow native notification surface owned by the controller. */
export interface BackgroundNotification {
  on(event: 'click' | 'close', listener: () => void): void
  removeListener(event: 'click' | 'close', listener: () => void): void
  show(): void
}

/** Electron operations injected after app readiness. */
export interface BackgroundPresenceNative {
  readonly locale: string
  readonly platform: NodeJS.Platform
  createTray(iconPath: string): BackgroundTray
  buildMenu(template: readonly BackgroundMenuItem[]): unknown
  createNotification(options: { readonly title: string; readonly body: string }): BackgroundNotification
}

/** Platform-specific tray assets copied into the deployed application. */
interface BackgroundPresenceAssets {
  readonly windowsIconPath: string
  readonly macTemplateIconPath: string
}

/** Observer callbacks are wired by the controller but configured by Main. */
type BackgroundPresenceObserverFactory = (callbacks: {
  readonly onState: (state: TaskObserverState) => void
  readonly reportError: (error: unknown) => void
}) => TaskObserver

/** Dependencies available only after Electron readiness and Harness startup. */
export interface BackgroundPresenceOptions {
  readonly actions: BackgroundPresenceActions
  readonly updates?: Pick<DesktopUpdates, 'currentState' | 'subscribe' | 'check' | 'install'>
  readonly assets: BackgroundPresenceAssets
  readonly native: BackgroundPresenceNative
  readonly createObserver: BackgroundPresenceObserverFactory
}

/** Owned native resources and authoritative Task observer. */
export interface BackgroundPresence {
  /** Return the latest detached observer value, initially unavailable until the first poll. */
  currentState(): TaskObserverState
  /** Stop all callbacks and release each native resource exactly once. */
  dispose(): Promise<void>
}

interface BackgroundCopy {
  readonly open: string
  readonly quit: string
  readonly checkUpdates: string
  readonly checkingUpdates: string
  readonly downloadingUpdate: string
  readonly updateError: string
  readonly upToDate: string
  readonly installUpdate: (version: string) => string
  readonly updateReadyTitle: string
  readonly updateReadyBody: (version: string) => string
  readonly unavailable: string
  readonly live: (state: TaskObserverState) => string
}

type NotificationEvent = 'click' | 'close'

interface NotificationOwnership {
  readonly listeners: Readonly<Record<NotificationEvent, () => void>>
  readonly installedEvents: Set<NotificationEvent>
}

const englishCopy: BackgroundCopy = {
  open: 'Open DeepSeek Harness',
  quit: 'Quit',
  checkUpdates: 'Check for Updates',
  checkingUpdates: 'Checking for updates…',
  downloadingUpdate: 'Downloading update…',
  updateError: 'Update check failed — retry',
  upToDate: 'Up to date',
  installUpdate: version => `Install update ${version}…`,
  updateReadyTitle: 'DeepSeek Harness update ready',
  updateReadyBody: version => `Version ${version} is downloaded. Click to review installation.`,
  unavailable: 'Task activity unavailable',
  live: state => `${state.activeTaskCount} tasks running · ${state.activeAgentCount} agents · ${state.attentionCount} needs attention`,
}

const chineseCopy: BackgroundCopy = {
  open: '打开 DeepSeek Harness',
  quit: '退出',
  checkUpdates: '检查更新',
  checkingUpdates: '正在检查更新…',
  downloadingUpdate: '正在下载更新…',
  updateError: '检查更新失败 — 重试',
  upToDate: '已是最新版本',
  installUpdate: version => `安装更新 ${version}…`,
  updateReadyTitle: 'DeepSeek Harness 更新已就绪',
  updateReadyBody: version => `版本 ${version} 已下载，点击确认安装。`,
  unavailable: '任务状态暂不可用',
  live: state => `${state.activeTaskCount} 个任务运行中 · ${state.activeAgentCount} 个 Agent · ${state.attentionCount} 项待处理`,
}

function selectCopy(locale: string): BackgroundCopy {
  return /^zh(?:-|$)/iu.test(locale) ? chineseCopy : englishCopy
}

function captureFailure(errors: unknown[], operation: () => void): void {
  try {
    operation()
  } catch (error) {
    errors.push(error)
  }
}

function combinedFailure(errors: readonly unknown[], message: string): unknown {
  if (errors.length === 1) return errors[0]
  return new AggregateError(errors, message, { cause: errors[0] })
}

/**
 * Create one task-aware native background-presence owner.
 * @param options - Ready Electron adapter, application actions, and observer factory.
 * @returns The asynchronous lifecycle owner.
 */
export function createBackgroundPresence(options: BackgroundPresenceOptions): BackgroundPresence {
  const copy = selectCopy(options.native.locale)
  const iconPath = options.native.platform === 'darwin'
    ? options.assets.macTemplateIconPath
    : options.assets.windowsIconPath
  const tray = options.native.createTray(iconPath)
  const notifications = new Map<BackgroundNotification, NotificationOwnership>()
  let disposed = false
  let observer: TaskObserver
  let disposal: Promise<void> | undefined
  let openSessionFlight: Promise<void> | undefined
  let disposeUpdates: (() => void) | undefined
  let lastUpdateKind: DesktopUpdateState['kind'] | undefined
  let currentState: TaskObserverState = Object.freeze({
    activeTaskCount: 0,
    activeAgentCount: 0,
    attentionCount: 0,
    notifications: Object.freeze([]),
    freshness: 'unavailable',
  })

  function reportFailure(error: unknown): void {
    if (disposed) return
    try {
      options.actions.reportFailure(error)
    } catch (reportError) {
      // A failure reporter cannot escape an Electron native callback.
      console.error('Desktop background-presence failure reporter failed', reportError)
    }
  }

  function runAction(action: () => void | Promise<void>): void {
    if (disposed) return
    try {
      Promise.resolve(action()).catch(reportFailure)
    } catch (error) {
      reportFailure(error)
    }
  }

  function openSession(sessionId?: SessionId): void {
    if (disposed || openSessionFlight !== undefined) return
    try {
      openSessionFlight = Promise.resolve(sessionId === undefined
        ? options.actions.openSession()
        : options.actions.openSession(sessionId))
      void openSessionFlight.catch(reportFailure).finally(() => { openSessionFlight = undefined })
    } catch (error) {
      reportFailure(error)
    }
  }

  function releaseNotification(notification: BackgroundNotification): unknown[] {
    const ownership = notifications.get(notification)
    if (ownership === undefined) return []
    notifications.delete(notification)
    const failures: unknown[] = []
    for (const event of ownership.installedEvents) {
      captureFailure(failures, () => { notification.removeListener(event, ownership.listeners[event]) })
    }
    ownership.installedEvents.clear()
    return failures
  }

  const open = () => { openSession() }
  const quit = () => { runAction(options.actions.requestQuit) }
  const checkUpdates = () => { runAction(() => options.updates?.check()) }
  const installUpdate = () => { runAction(() => options.updates?.install()) }

  function updateMenuItem(state: DesktopUpdateState): BackgroundMenuItem {
    switch (state.kind) {
      case 'checking': return { label: copy.checkingUpdates, enabled: false }
      case 'downloading': return { label: copy.downloadingUpdate, enabled: false }
      case 'ready': return { label: copy.installUpdate(state.version), click: installUpdate }
      case 'installing': return { label: copy.installUpdate(state.version), enabled: false }
      case 'error': return { label: copy.updateError, click: checkUpdates }
      case 'up-to-date': return { label: copy.upToDate, click: checkUpdates }
      case 'idle': return { label: copy.checkUpdates, click: checkUpdates }
    }
    return assertNever(state)
  }

  function showNotification(title: string, body: string, onClick: () => void): void {
    let notification: BackgroundNotification | undefined
    try {
      const createdNotification = options.native.createNotification({ title, body })
      notification = createdNotification
      const listeners: Readonly<Record<NotificationEvent, () => void>> = {
        click: () => {
          const failures = releaseNotification(createdNotification)
          if (failures.length > 0) reportFailure(combinedFailure(failures, 'Desktop notification cleanup failed'))
          onClick()
        },
        close: () => {
          const failures = releaseNotification(createdNotification)
          if (failures.length > 0) reportFailure(combinedFailure(failures, 'Desktop notification cleanup failed'))
        },
      }
      const ownership: NotificationOwnership = { listeners, installedEvents: new Set() }
      notifications.set(createdNotification, ownership)
      for (const event of ['click', 'close'] as const) {
        ownership.installedEvents.add(event)
        createdNotification.on(event, listeners[event])
      }
      createdNotification.show()
    } catch (error) {
      const failures = [error]
      if (notification !== undefined) failures.push(...releaseNotification(notification))
      reportFailure(combinedFailure(failures, 'Desktop notification setup and cleanup failed'))
    }
  }

  function renderMenu(): void {
    if (disposed) return
    const summary = currentState.freshness === 'live' ? copy.live(currentState) : copy.unavailable
    try { tray.setToolTip(summary) } catch (error) { reportFailure(error) }
    try {
      tray.setContextMenu(options.native.buildMenu([
        { label: summary, enabled: false },
        { type: 'separator' },
        { label: copy.open, click: open },
        ...(options.updates === undefined ? [] : [updateMenuItem(options.updates.currentState())]),
        { label: copy.quit, click: quit },
      ]))
    } catch (error) { reportFailure(error) }
  }

  function render(state: TaskObserverState): void {
    if (disposed) return
    currentState = state
    renderMenu()
    for (const transition of state.notifications) {
      showNotification(transition.title, transition.body, () => { openSession(transition.ownerSessionId) })
    }
  }

  try {
    tray.on('click', open)
    tray.on('double-click', open)
    observer = options.createObserver({ onState: render, reportError: reportFailure })
    disposeUpdates = options.updates?.subscribe((state) => {
      renderMenu()
      if (state.kind === 'ready' && lastUpdateKind !== 'ready') {
        showNotification(copy.updateReadyTitle, copy.updateReadyBody(state.version), installUpdate)
      }
      lastUpdateKind = state.kind
    })
  } catch (error) {
    const failures: unknown[] = [error]
    if (disposeUpdates !== undefined) captureFailure(failures, disposeUpdates)
    captureFailure(failures, () => { tray.removeListener('click', open) })
    captureFailure(failures, () => { tray.removeListener('double-click', open) })
    captureFailure(failures, () => { tray.destroy() })
    throw combinedFailure(failures, 'Desktop background-presence initialization and cleanup failed')
  }

  return {
    currentState: () => currentState,
    dispose() {
      if (disposal !== undefined) return disposal
      disposed = true
      let resolveDisposal!: () => void
      let rejectDisposal!: (error: unknown) => void
      disposal = new Promise<void>((resolve, reject) => {
        resolveDisposal = resolve
        rejectDisposal = reject
      })
      const failures: unknown[] = []
      if (disposeUpdates !== undefined) captureFailure(failures, disposeUpdates)
      captureFailure(failures, () => { tray.removeListener('click', open) })
      captureFailure(failures, () => { tray.removeListener('double-click', open) })
      for (const notification of [...notifications.keys()]) {
        failures.push(...releaseNotification(notification))
      }
      void (async () => {
        try {
          await observer.dispose()
        } catch (error) {
          failures.push(error)
        }
        captureFailure(failures, () => { tray.destroy() })
        if (failures.length === 0) {
          resolveDisposal()
        } else {
          rejectDisposal(combinedFailure(failures, 'Desktop background-presence disposal failed'))
        }
      })()
      return disposal
    },
  }
}

function assertNever(value: never): never { throw new Error(`Unexpected desktop update state: ${String(value)}`) }
