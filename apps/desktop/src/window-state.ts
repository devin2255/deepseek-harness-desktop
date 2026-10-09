/** Main-owned window preferences; no Session, Renderer, or Harness state is stored here. */
import { lstat, open } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const WINDOW_STATE_VERSION = 1
const MAX_STATE_BYTES = 2_048

/** Native window rectangle measured in device-independent pixels, including its frame. */
export interface WindowBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Versioned preference file; transient minimized and fullscreen modes are not persisted. */
export interface SavedWindowState {
  readonly version: 1
  readonly bounds: WindowBounds
  readonly maximized: boolean
}

/** Creation values adjusted to one currently available display work area. */
export interface WindowPlacement {
  readonly bounds: WindowBounds
  readonly minWidth: number
  readonly minHeight: number
  readonly maximized: boolean
}

/** Native setters used to settle the requested rectangle before observing or maximizing it. */
export interface WindowPlacementTarget {
  getNormalBounds(): WindowBounds
  setBounds(bounds: WindowBounds): void
  setMinimumSize(width: number, height: number): void
}

/**
 * Apply measured native geometry without accumulating fractional-scale frame rounding on reopen.
 * @param window - New ordinary native window, before maximization or state observation.
 * @param placement - Current-display-adjusted creation values.
 * @returns Nothing; rejects a native setter that cannot settle the requested rectangle.
 */
export function applyWindowPlacement(window: WindowPlacementTarget, placement: WindowPlacement): void {
  const desired = placement.bounds
  let requested = { ...desired }
  window.setMinimumSize(0, 0)
  // Bound feedback for native frame/DIP rounding; never guess a platform-specific pixel offset.
  for (let attempt = 0; attempt < 3; attempt++) {
    window.setBounds(requested)
    const actual = window.getNormalBounds()
    if (actual.x === desired.x && actual.y === desired.y && actual.width === desired.width && actual.height === desired.height) {
      window.setMinimumSize(
        Math.max(1, placement.minWidth + requested.width - desired.width),
        Math.max(1, placement.minHeight + requested.height - desired.height),
      )
      return
    }
    requested = {
      x: requested.x + desired.x - actual.x,
      y: requested.y + desired.y - actual.y,
      width: requested.width + desired.width - actual.width,
      height: requested.height + desired.height - actual.height,
    }
    if (requested.width <= 0 || requested.height <= 0) break
  }
  throw new Error('Desktop native window could not restore its requested rectangle')
}

/** Native events that can change a remembered normal rectangle or maximization. */
type WindowStateEvent = 'move' | 'resize' | 'maximize' | 'unmaximize' | 'restore' | 'hide' | 'close'

/** Electron operations consumed without exposing a window to the Renderer. */
export interface RememberedWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isFullScreen(): boolean
  isMaximized(): boolean
  getNormalBounds(): WindowBounds
  on(event: WindowStateEvent | 'closed', listener: () => void): unknown
  off(event: WindowStateEvent | 'closed', listener: () => void): unknown
}

/** Storage and scheduling inputs explicitly selected by the desktop composition. */
export interface WindowStateOptions {
  readonly filePath: string
  readonly saveDelayMs: number
  readonly reportFailure: (error: unknown) => void
}

/** Replaceable file operations for storage failures without replacing native geometry policy. */
export interface WindowStateStorage {
  read(): Promise<string | undefined>
  write(content: string): Promise<void>
}

/**
 * Restore valid saved geometry onto a current display, keeping the entire frame visible.
 * @param saved - Validated normal geometry, or no previously saved preference.
 * @param workAreas - Current display work areas in Electron's device-independent coordinates.
 * @param primaryWorkArea - Current primary display work area, used when the old display is absent.
 * @returns Creation bounds and minimum dimensions that fit the selected display.
 */
export function resolveWindowPlacement(
  saved: SavedWindowState | undefined,
  workAreas: readonly WindowBounds[],
  primaryWorkArea: WindowBounds,
): WindowPlacement {
  let area = primaryWorkArea
  let overlap = 0
  if (saved !== undefined) {
    for (const candidate of workAreas) {
      const intersection = intersectionArea(saved.bounds, candidate)
      if (intersection > overlap) { area = candidate; overlap = intersection }
    }
  }
  const minWidth = Math.min(960, area.width)
  const minHeight = Math.min(640, area.height)
  const width = Math.min(area.width, Math.max(minWidth, saved?.bounds.width ?? 1280))
  const height = Math.min(area.height, Math.max(minHeight, saved?.bounds.height ?? 800))
  const x = overlap > 0 && saved !== undefined ? saved.bounds.x : area.x + Math.floor((area.width - width) / 2)
  const y = overlap > 0 && saved !== undefined ? saved.bounds.y : area.y + Math.floor((area.height - height) / 2)
  return {
    bounds: {
      x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
      y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
      width,
      height,
    },
    minWidth,
    minHeight,
    maximized: saved?.maximized ?? false,
  }
}

/**
 * Parse the bounded on-disk preference without accepting unknown fields or older formats.
 * @param content - UTF-8 preference file contents.
 * @returns Validated window state; invalid files throw and are diagnosed by the store.
 */
export function parseWindowState(content: string): SavedWindowState {
  if (Buffer.byteLength(content, 'utf8') > MAX_STATE_BYTES) throw new Error('Desktop window state exceeds its size limit')
  const value: unknown = JSON.parse(content)
  if (!exactRecord(value, ['version', 'bounds', 'maximized']) || value.version !== WINDOW_STATE_VERSION
    || typeof value.maximized !== 'boolean' || !exactRecord(value.bounds, ['x', 'y', 'width', 'height'])
    || !validBounds(value.bounds)) throw new Error('Desktop window state has invalid fields or an unsupported version')
  return { version: WINDOW_STATE_VERSION, bounds: { ...value.bounds }, maximized: value.maximized }
}

/** Own the sole main window's preference writes, coalescing movement and awaiting publication on exit. */
export class WindowStateStore {
  private readonly storage: WindowStateStorage
  private loaded?: Promise<void>
  private saved?: SavedWindowState
  private pending: string | undefined
  private published?: string
  private writing: Promise<void> | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly observers = new Set<{ readonly capture: () => void; readonly dispose: () => void }>()
  private disposed = false

  constructor(private readonly options: WindowStateOptions, storage?: WindowStateStorage) {
    if (!Number.isSafeInteger(options.saveDelayMs) || options.saveDelayMs <= 0) {
      throw new Error('Desktop window saveDelayMs must be a positive integer')
    }
    this.storage = storage ?? {
      read: () => readWindowStateFile(options.filePath),
      write: content => writeFileAtomic(options.filePath, content, { mode: 0o600, dirMode: 0o700 }),
    }
  }

  /**
   * Load once and wait for any preceding window's queued writes before recreating its layout.
   * @param workAreas - Live display work areas after Electron readiness.
   * @param primaryWorkArea - Live primary display work area.
   * @returns Safe creation values; storage failures are reported and use the default placement.
   */
  async restore(workAreas: readonly WindowBounds[], primaryWorkArea: WindowBounds): Promise<WindowPlacement> {
    if (this.disposed) throw new Error('Desktop window state store is disposed')
    this.loaded ??= this.load()
    await this.loaded
    await this.flush()
    return resolveWindowPlacement(this.saved, workAreas, primaryWorkArea)
  }

  /**
   * Observe one live authorized window and remove every owned listener when it closes.
   * @param window - Main-owned native window, never the startup or recovery window.
   * @returns An idempotent disposer that also starts publication of the last captured state.
   */
  track(window: RememberedWindow): () => void {
    if (this.disposed) throw new Error('Desktop window state store is disposed')
    let maximized = this.saved?.maximized ?? false
    let disposed = false
    const capture = (): void => {
      if (disposed) return
      try {
        if (window.isDestroyed()) return
        if (!window.isMinimized() && !window.isFullScreen()) maximized = window.isMaximized()
        this.saved = { version: WINDOW_STATE_VERSION, bounds: { ...window.getNormalBounds() }, maximized }
        this.pending = `${JSON.stringify(this.saved)}\n`
        if (this.timer !== undefined) clearTimeout(this.timer)
        this.timer = setTimeout(() => { void this.flush() }, this.options.saveDelayMs)
        this.timer.unref()
      } catch (error: unknown) { this.report(error) }
    }
    const events: readonly WindowStateEvent[] = ['move', 'resize', 'maximize', 'unmaximize', 'restore', 'hide', 'close']
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      this.observers.delete(observer)
      for (const event of events) {
        try { window.off(event, capture) } catch (error: unknown) { this.report(error) }
      }
      try { window.off('closed', dispose) } catch (error: unknown) { this.report(error) }
      void this.flush()
    }
    const observer = { capture, dispose }
    this.observers.add(observer)
    try {
      for (const event of events) window.on(event, capture)
      window.on('closed', dispose)
    } catch (error: unknown) { dispose(); throw error }
    return dispose
  }

  /**
   * Capture live geometry, stop observing native events, and settle all owned writes.
   * @returns Idempotent preference cleanup; it never destroys a window or stops a Task.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const observer of [...this.observers]) { observer.capture(); observer.dispose() }
    await this.flush()
  }

  /**
   * Publish queued preferences in order before recreation or bounded application shutdown.
   * @returns Settlement after all currently queued writes; failures are diagnosed, not propagated.
   */
  async flush(): Promise<void> {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    if (this.writing !== undefined) { await this.writing; return this.flush() }
    if (this.pending === undefined) return
    this.writing = this.publish()
    try { await this.writing } finally { this.writing = undefined }
  }

  private async load(): Promise<void> {
    try {
      const content = await this.storage.read()
      if (content === undefined) return
      this.saved = parseWindowState(content)
      this.published = `${JSON.stringify(this.saved)}\n`
    } catch (error: unknown) { this.report(error) }
  }

  private async publish(): Promise<void> {
    while (this.pending !== undefined) {
      const content = this.pending
      this.pending = undefined
      if (content === this.published) continue
      try {
        await this.storage.write(content)
        this.published = content
      } catch (error: unknown) { this.report(error) }
    }
  }

  private report(error: unknown): void {
    try { this.options.reportFailure(error) } catch { /* Diagnostic failures cannot escape native window callbacks. */ }
  }
}

/** Read only a small regular preference file; missing preferences are an ordinary first launch. */
async function readWindowStateFile(path: string): Promise<string | undefined> {
  try {
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Desktop window state must be a regular file')
    const file = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(MAX_STATE_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > MAX_STATE_BYTES) throw new Error('Desktop window state exceeds its size limit')
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally { await file.close() }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
}

function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function validBounds(value: Record<string, unknown>): value is Record<string, unknown> & WindowBounds {
  return ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(value[key]))
    && (value.width as number) > 0 && (value.height as number) > 0
    && Number.isSafeInteger((value.x as number) + (value.width as number))
    && Number.isSafeInteger((value.y as number) + (value.height as number))
}

function intersectionArea(first: WindowBounds, second: WindowBounds): number {
  return Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x))
    * Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y))
}
