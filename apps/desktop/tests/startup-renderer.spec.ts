// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopStartupState } from '../src/startup-state.ts'

describe('startup renderer', () => {
  beforeEach(() => {
    vi.resetModules()
    document.body.innerHTML = `
      <p data-phase></p>
      <div data-progress></div>
      <section data-failure-actions hidden><p data-failure-message></p></section>
      <button data-retry></button>
      <button data-open-logs></button>
      <button data-exit></button>
    `
  })

  it('renders safe states and forwards only explicit recovery clicks', async () => {
    let receiveState: ((state: DesktopStartupState) => void) | undefined
    const retry = vi.fn(() => Promise.resolve())
    const openLogs = vi.fn(() => Promise.resolve())
    const exit = vi.fn(() => Promise.resolve())
    Object.defineProperty(window, 'deepseekStartup', {
      configurable: true,
      value: Object.freeze({
        onState(listener: (state: DesktopStartupState) => void) {
          receiveState = listener
          return () => {}
        },
        retry,
        openLogs,
        exit,
      }),
    })

    await import('../src/startup-renderer.ts')
    receiveState?.({
      attempt: 1,
      phase: 'failed',
      status: 'failed',
      error: { code: 'profile-invalid', action: 'Open the desktop log.' },
    })
    document.querySelector<HTMLElement>('[data-retry]')?.click()
    document.querySelector<HTMLElement>('[data-open-logs]')?.click()
    document.querySelector<HTMLElement>('[data-exit]')?.click()

    expect(document.querySelector('[data-phase]')?.textContent).toBe('Startup needs attention')
    expect(document.querySelector('[data-progress]')?.hasAttribute('hidden')).toBe(true)
    expect(document.querySelector('[data-failure-actions]')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('[data-failure-message]')?.textContent).toBe('Open the desktop log.')
    expect([retry.mock.calls.length, openLogs.mock.calls.length, exit.mock.calls.length]).toEqual([1, 1, 1])
  })
})
