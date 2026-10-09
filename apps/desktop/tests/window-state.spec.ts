import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyWindowPlacement, parseWindowState, resolveWindowPlacement, WindowStateStore,
  type RememberedWindow, type SavedWindowState, type WindowBounds, type WindowStateStorage,
} from '../src/window-state.ts'

const primary: WindowBounds = { x: 0, y: 0, width: 1920, height: 1040 }
const normal: WindowBounds = { x: 120, y: 80, width: 1100, height: 700 }
const saved: SavedWindowState = { version: 1, bounds: normal, maximized: false }
const directories: string[] = []

class NativeWindow extends EventEmitter implements RememberedWindow {
  bounds = { ...normal }
  maximized = false
  minimized = false
  fullscreen = false
  destroyed = false
  isDestroyed(): boolean { return this.destroyed }
  isMinimized(): boolean { return this.minimized }
  isFullScreen(): boolean { return this.fullscreen }
  isMaximized(): boolean { return this.maximized }
  getNormalBounds(): WindowBounds { return this.bounds }
}

function memoryStore(storage: Partial<WindowStateStorage> = {}): {
  readonly store: WindowStateStore
  readonly write: ReturnType<typeof vi.fn<WindowStateStorage['write']>>
  readonly report: ReturnType<typeof vi.fn>
} {
  const write = vi.fn<WindowStateStorage['write']>(async () => {})
  const report = vi.fn()
  const store = new WindowStateStore({ filePath: '/unused', saveDelayMs: 250, reportFailure: report }, {
    read: async () => undefined,
    write,
    ...storage,
  })
  return { store, write, report }
}

async function stateFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-window-state-'))
  directories.push(directory)
  return join(directory, 'window-state.json')
}

afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('resolveWindowPlacement', () => {
  it('centers the initial window in the primary work area', () => {
    expect(resolveWindowPlacement(undefined, [primary], primary)).toEqual({
      bounds: { x: 320, y: 120, width: 1280, height: 800 }, minWidth: 960, minHeight: 640, maximized: false,
    })
  })

  it('retains a visible normal rectangle and maximization', () => {
    expect(resolveWindowPlacement({ ...saved, maximized: true }, [primary], primary)).toEqual({
      bounds: normal, minWidth: 960, minHeight: 640, maximized: true,
    })
  })

  it('keeps a negative-coordinate secondary monitor rather than treating its origin as missing', () => {
    const secondary = { x: -1920, y: -100, width: 1920, height: 1080 }
    const bounds = { x: -1800, y: -50, width: 1100, height: 700 }
    expect(resolveWindowPlacement({ ...saved, bounds }, [primary, secondary], primary).bounds).toEqual(bounds)
  })

  it('chooses the work area with the largest intersection and clamps the full frame into it', () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 720 }
    const bounds = { x: 1800, y: 50, width: 1100, height: 700 }
    expect(resolveWindowPlacement({ ...saved, bounds }, [primary, secondary], primary).bounds)
      .toEqual({ x: 1920, y: 20, width: 1100, height: 700 })
  })

  it('centers a removed-monitor preference on the primary display', () => {
    const bounds = { x: 9000, y: -9000, width: 1100, height: 700 }
    expect(resolveWindowPlacement({ ...saved, bounds }, [primary], primary).bounds)
      .toEqual({ x: 410, y: 170, width: 1100, height: 700 })
  })

  it('fits reduced work areas and reduces minimum dimensions on small screens', () => {
    const small = { x: -800, y: 20, width: 800, height: 580 }
    expect(resolveWindowPlacement(saved, [small], small)).toEqual({
      bounds: small, minWidth: 800, minHeight: 580, maximized: false,
    })
    expect(resolveWindowPlacement({ ...saved, bounds: { x: 0, y: 0, width: 200, height: 300 } }, [primary], primary).bounds)
      .toEqual({ x: 0, y: 0, width: 960, height: 640 })
  })

  it('uses the explicit primary work area if the display list is empty', () => {
    expect(resolveWindowPlacement(saved, [], primary).bounds).toEqual({ x: 410, y: 170, width: 1100, height: 700 })
  })
})

describe('applyWindowPlacement', () => {
  it('settles the requested rectangle and normal minimum dimensions', () => {
    const placement = resolveWindowPlacement(saved, [primary], primary)
    const setBounds = vi.fn()
    const setMinimumSize = vi.fn()
    applyWindowPlacement({ getNormalBounds: () => normal, setBounds, setMinimumSize }, placement)
    expect(setBounds).toHaveBeenCalledExactlyOnceWith(normal)
    expect(setMinimumSize.mock.calls).toEqual([[0, 0], [960, 640]])
  })

  it('corrects measured frame rounding and the corresponding native minimum without a DPI-specific constant', () => {
    const placement = resolveWindowPlacement(saved, [primary], primary)
    let actual = normal
    const setBounds = vi.fn((requested: WindowBounds) => {
      actual = { x: requested.x + 1, y: requested.y, width: requested.width + 2, height: requested.height + 2 }
    })
    const setMinimumSize = vi.fn()
    applyWindowPlacement({ getNormalBounds: () => actual, setBounds, setMinimumSize }, placement)
    expect(actual).toEqual(normal)
    expect(setBounds).toHaveBeenCalledTimes(2)
    expect(setBounds.mock.calls[1]).toEqual([{ ...normal, x: normal.x - 1, width: normal.width - 2, height: normal.height - 2 }])
    expect(setMinimumSize.mock.calls.at(-1)).toEqual([958, 638])
  })

  it('bounds native feedback when the OS refuses positioning', () => {
    const placement = resolveWindowPlacement(saved, [primary], primary)
    const setBounds = vi.fn()
    expect(() => {
      applyWindowPlacement({ getNormalBounds: () => ({ ...normal, x: 0 }), setBounds, setMinimumSize() {} }, placement)
    }).toThrow('could not restore')
    expect(setBounds).toHaveBeenCalledTimes(3)
  })

  it('never passes nonpositive corrected dimensions to a native setter', () => {
    const placement = resolveWindowPlacement(saved, [primary], primary)
    const setBounds = vi.fn()
    expect(() => {
      applyWindowPlacement({
        getNormalBounds: () => ({ ...normal, width: normal.width * 3 }), setBounds, setMinimumSize() {},
      }, placement)
    }).toThrow('could not restore')
    expect(setBounds).toHaveBeenCalledTimes(1)
  })
})

describe('parseWindowState', () => {
  it('accepts only versioned normal geometry in device-independent pixels', () => {
    expect(parseWindowState(JSON.stringify(saved))).toEqual(saved)
  })

  it.each([
    null, [], { ...saved, version: 0 }, { ...saved, unknown: true }, { ...saved, maximized: 1 },
    { bounds: normal, maximized: false }, { ...saved, bounds: [] },
    ...['x', 'y', 'width', 'height'].flatMap(key => [
      { ...saved, bounds: { ...normal, [key]: '100' } }, { ...saved, bounds: { ...normal, [key]: 1.5 } },
    ]),
    { ...saved, bounds: { ...normal, width: 0 } }, { ...saved, bounds: { ...normal, height: -1 } },
    { ...saved, bounds: { ...normal, extra: 0 } }, { ...saved, bounds: { ...normal, x: Number.MAX_SAFE_INTEGER } },
    { ...saved, bounds: { ...normal, y: Number.MAX_SAFE_INTEGER } },
  ])('rejects invalid durable fields: %j', (value) => {
    expect(() => parseWindowState(JSON.stringify(value))).toThrow('invalid fields or an unsupported version')
  })

  it('rejects malformed and excessive file contents', () => {
    expect(() => parseWindowState('{')).toThrow()
    expect(() => parseWindowState(' '.repeat(2049))).toThrow('size limit')
    expect(() => parseWindowState('中'.repeat(700))).toThrow('size limit')
  })
})

describe('WindowStateStore', () => {
  it('publishes a real file and restores it in a new store after closure', async () => {
    const filePath = await stateFile()
    const reportFailure = vi.fn()
    const options = { filePath, saveDelayMs: 250, reportFailure }
    const first = new WindowStateStore(options)
    expect((await first.restore([primary], primary)).maximized).toBe(false)
    const window = new NativeWindow()
    first.track(window)
    window.maximized = true
    window.emit('maximize')
    window.destroyed = true
    window.emit('closed')
    await first.flush()
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ ...saved, maximized: true })
    expect((await new WindowStateStore(options).restore([primary], primary)).bounds).toEqual(normal)
    expect((await new WindowStateStore(options).restore([primary], primary)).maximized).toBe(true)
    expect(window.eventNames()).toEqual([])
    expect(reportFailure).not.toHaveBeenCalled()
  })

  it('coalesces rapid moves and publishes without requiring a normal close', async () => {
    vi.useFakeTimers()
    const { store, write } = memoryStore()
    await store.restore([primary], primary)
    const window = new NativeWindow()
    const dispose = store.track(window)
    window.emit('move')
    window.bounds = { ...normal, x: 250 }
    window.emit('resize')
    expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(250)
    expect(write).toHaveBeenCalledExactlyOnceWith(`${JSON.stringify({ ...saved, bounds: window.bounds })}\n`)
    window.emit('move')
    await store.flush()
    expect(write).toHaveBeenCalledTimes(1)
    dispose()
    dispose()
    expect(window.eventNames()).toEqual([])
  })

  it('serializes an in-flight write before the most recent layout and restoration', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const write = vi.fn<WindowStateStorage['write']>().mockImplementationOnce(() => blocked).mockResolvedValue(undefined)
    const { store } = memoryStore({ write })
    await store.restore([primary], primary)
    const window = new NativeWindow()
    const dispose = store.track(window)
    window.emit('move')
    const flushing = store.flush()
    window.bounds = { ...normal, x: 340 }
    window.emit('move')
    const restoring = store.restore([primary], primary)
    expect(write).toHaveBeenCalledTimes(1)
    release()
    await flushing
    expect((await restoring).bounds.x).toBe(340)
    expect(write).toHaveBeenCalledTimes(2)
    expect(parseWindowState(write.mock.calls[1]![0]).bounds.x).toBe(340)
    dispose()
  })

  it('ignores an already-dispatched native callback after its observer is disposed', async () => {
    vi.useFakeTimers()
    const { store, write } = memoryStore()
    const window = new NativeWindow()
    const dispose = store.track(window)
    const dispatched = window.listeners('move')[0] as () => void
    const bounds = vi.spyOn(window, 'getNormalBounds')
    dispose()
    dispatched()
    await store.flush()
    expect(bounds).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('preserves normal geometry and maximization while minimized or fullscreen', async () => {
    const { store, write } = memoryStore()
    await store.restore([primary], primary)
    const window = new NativeWindow()
    const dispose = store.track(window)
    window.maximized = true
    window.emit('maximize')
    window.maximized = false
    window.minimized = true
    window.emit('hide')
    window.minimized = false
    window.fullscreen = true
    window.emit('resize')
    await store.flush()
    expect(JSON.parse(write.mock.calls.at(-1)![0])).toEqual({ ...saved, maximized: true })
    window.fullscreen = false
    window.emit('unmaximize')
    await store.flush()
    expect(JSON.parse(write.mock.calls.at(-1)![0])).toEqual(saved)
    dispose()
  })

  it('contains capture and diagnostic failures, and ignores destroyed windows', async () => {
    const failure = new Error('native bounds unavailable')
    const { store, write, report } = memoryStore()
    const window = new NativeWindow()
    const dispose = store.track(window)
    vi.spyOn(window, 'getNormalBounds').mockImplementation(() => { throw failure })
    report.mockImplementation(() => { throw new Error('diagnostic unavailable') })
    expect(() => window.emit('move')).not.toThrow()
    window.destroyed = true
    window.emit('resize')
    await store.flush()
    expect(report).toHaveBeenCalledExactlyOnceWith(failure)
    expect(write).not.toHaveBeenCalled()
    dispose()
  })

  it('diagnoses read and publication failures without preventing native-window use', async () => {
    const failure = new Error('disk unavailable')
    const read = vi.fn<WindowStateStorage['read']>().mockRejectedValue(failure)
    const write = vi.fn<WindowStateStorage['write']>().mockRejectedValueOnce(failure).mockResolvedValue(undefined)
    const { store, report } = memoryStore({ read, write })
    expect((await store.restore([primary], primary)).bounds.width).toBe(1280)
    const window = new NativeWindow()
    const dispose = store.track(window)
    window.emit('move')
    await expect(store.flush()).resolves.toBeUndefined()
    window.emit('move')
    await store.flush()
    expect(write).toHaveBeenCalledTimes(2)
    expect(read).toHaveBeenCalledTimes(1)
    expect(report.mock.calls).toEqual([[failure], [failure]])
    dispose()
  })

  it.each(['{', JSON.stringify({ ...saved, version: 0 }), ' '.repeat(2049)])('diagnoses an invalid real file and restores a safe default', async (content) => {
    const filePath = await stateFile()
    await writeFile(filePath, content)
    const reportFailure = vi.fn()
    const store = new WindowStateStore({ filePath, saveDelayMs: 250, reportFailure })
    expect((await store.restore([primary], primary)).bounds.width).toBe(1280)
    expect(reportFailure).toHaveBeenCalledTimes(1)
    expect(await readFile(filePath, 'utf8')).toBe(content)
  })

  it('rejects a directory in place of the preference file', async () => {
    const filePath = await stateFile()
    await mkdir(filePath)
    const reportFailure = vi.fn()
    const store = new WindowStateStore({ filePath, saveDelayMs: 250, reportFailure })
    await store.restore([primary], primary)
    expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({ message: 'Desktop window state must be a regular file' }))
  })

  it('captures the last live bounds, removes native listeners, and awaits outstanding publication on dispose', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const write = vi.fn<WindowStateStorage['write']>().mockImplementationOnce(() => blocked).mockResolvedValue(undefined)
    const { store } = memoryStore({ write })
    const window = new NativeWindow()
    store.track(window)
    window.emit('move')
    const first = store.flush()
    window.bounds = { ...normal, x: 500 }
    const stopping = store.dispose()
    expect(window.eventNames()).toEqual([])
    release()
    await first
    await stopping
    await store.dispose()
    expect(parseWindowState(write.mock.calls.at(-1)![0]).bounds.x).toBe(500)
    await expect(store.restore([primary], primary)).rejects.toThrow('disposed')
    expect(() => store.track(window)).toThrow('disposed')
  })

  it('removes partially registered listeners and contains listener-removal failures', async () => {
    const { store, report } = memoryStore()
    const window = new NativeWindow()
    const on = window.on.bind(window)
    vi.spyOn(window, 'on').mockImplementation((event, listener) => {
      if (event === 'closed') throw new Error('registration failed')
      return on(event, listener)
    })
    expect(() => store.track(window)).toThrow('registration failed')
    expect(window.eventNames()).toEqual([])
    vi.restoreAllMocks()
    const off = window.off.bind(window)
    vi.spyOn(window, 'off').mockImplementation((event, listener) => {
      off(event, listener)
      throw new Error('removal failed')
    })
    const dispose = store.track(window)
    expect(dispose).not.toThrow()
    expect(window.eventNames()).toEqual([])
    expect(report).toHaveBeenCalledTimes(8)
    await store.dispose()
  })

  it.each([0, -1, 1.5, NaN])('rejects an invalid save delay: %s', (saveDelayMs) => {
    expect(() => new WindowStateStore({ filePath: '/unused', saveDelayMs, reportFailure() {} })).toThrow('positive integer')
  })
})
