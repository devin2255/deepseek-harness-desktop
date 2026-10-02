/** Desktop notification navigation over the existing Task navigation controller. */
import {
  createSnapshotStore,
  type ObservableSnapshot,
  type SessionId,
} from '@deepseek-ai/dsh-client-runtime/client'

/** Renderer-safe subset exposed by the isolated Electron preload. */
export interface DesktopNavigationBridge {
  /** Subscribe to validated Main-owned Session targets. */
  onOpenSession(listener: (sessionId: SessionId) => void): () => void
}

/** Catalog readiness and change notification used to delay early desktop targets. */
export interface DesktopNavigationReadiness {
  /** Whether the authoritative Session catalog has completed its first usable baseline. */
  isReady(): boolean
  /** Subscribe to readiness changes. */
  subscribe(listener: () => void): () => void
}

/** Operations required by desktop notification navigation. */
export interface DesktopNavigationOptions {
  readonly bridge: DesktopNavigationBridge | undefined
  readonly readiness: DesktopNavigationReadiness
  readonly navigate: (sessionId: SessionId) => Promise<void>
  readonly showHome: () => void
}

/** Plugin-owned desktop navigation lifetime and presentation state. */
export interface DesktopNavigation {
  /** Latest current-attempt failure, consumed only by the overview presentation. */
  readonly failure: ObservableSnapshot<string | undefined>
  /** Supersede queued and in-flight desktop navigation and clear its failure. */
  supersede(): void
  /** Unsubscribe from the preload and catalog stores and fence pending work. */
  dispose(): void
}

/**
 * Resolve the optional preload bridge without requiring Electron in ordinary Web composition.
 * @returns The bridge when context isolation installed it, otherwise `undefined`.
 */
export function resolveDesktopNavigationBridge(): DesktopNavigationBridge | undefined {
  const candidate = (globalThis as typeof globalThis & { deepseekDesktop?: unknown }).deepseekDesktop
  if (!hasDesktopNavigationSubscription(candidate)) return undefined
  return {
    onOpenSession(listener) {
      const dispose = candidate.onOpenSession(listener)
      if (!isDisposer(dispose)) throw new Error('Desktop preload subscription did not return a disposer')
      return dispose
    },
  }
}

/**
 * Create latest-target desktop navigation with catalog-readiness and disposal fencing.
 * @param options - Optional preload bridge, authoritative readiness, navigation, and Home action.
 * @returns The presentation source and plugin-owned lifecycle operations.
 */
export function createDesktopNavigation(options: DesktopNavigationOptions): DesktopNavigation {
  const failure = createSnapshotStore<string | undefined>(undefined)
  let disposed = false
  let revision = 0
  let pending: SessionId | undefined
  let disposeBridge: (() => void) | undefined
  let disposeReadiness: (() => void) | undefined

  const setFailure = (next: string | undefined): void => {
    if (failure.getSnapshot() !== next) failure.set(next)
  }
  const supersede = (): void => {
    revision += 1
    pending = undefined
    setFailure(undefined)
  }
  const revealFailure = (error: unknown): void => {
    let message = failureMessage(error)
    setFailure(message)
    try {
      options.showHome()
    } catch (showError) {
      message = `${message}\n${failureMessage(showError)}`
      setFailure(message)
    }
  }
  const drain = (): void => {
    if (disposed || pending === undefined || !options.readiness.isReady()) return
    const target = pending
    pending = undefined
    const attempt = ++revision
    void Promise.resolve().then(() => options.navigate(target)).then(
      () => { if (!disposed && attempt === revision) setFailure(undefined) },
      (error: unknown) => { if (!disposed && attempt === revision) revealFailure(error) },
    )
  }
  const receive = (sessionId: SessionId): void => {
    if (disposed) return
    revision += 1
    pending = sessionId
    setFailure(undefined)
    drain()
  }

  if (options.bridge !== undefined) {
    try {
      disposeBridge = options.bridge.onOpenSession(receive)
      disposeReadiness = options.readiness.subscribe(drain)
      drain()
    } catch (error) {
      disposed = true
      revision += 1
      pending = undefined
      const failures = [error]
      for (const release of [disposeBridge, disposeReadiness]) {
        try { release?.() } catch (cleanupError) { failures.push(cleanupError) }
      }
      if (failures.length === 1) throw error
      throw new AggregateError(failures, 'Desktop navigation initialization failed and cleanup also failed', { cause: error })
    }
  }

  return {
    failure,
    supersede,
    dispose(): void {
      if (disposed) return
      disposed = true
      supersede()
      const failures: unknown[] = []
      for (const release of [disposeBridge, disposeReadiness]) {
        try { release?.() } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Desktop navigation disposal failed', { cause: failures[0] })
    },
  }
}

/** Collapse rejected values into readable overview text. */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Narrow the optional preload global to the one operation consumed by this plugin. */
function hasDesktopNavigationSubscription(value: unknown): value is {
  onOpenSession(listener: (sessionId: SessionId) => void): unknown
} {
  return typeof value === 'object' && value !== null
    && 'onOpenSession' in value && typeof value.onOpenSession === 'function'
}

/** Narrow the preload's runtime return before registering it as plugin cleanup. */
function isDisposer(value: unknown): value is () => void {
  return typeof value === 'function'
}
