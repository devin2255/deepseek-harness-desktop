import { describe, expect, it } from 'vitest'
import { resolveTelemetryPatch, shouldWatchUserPatches } from '../src/profile-boot.ts'

describe('resolveTelemetryPatch', () => {
  it('preserves the configured telemetry mode when the hard-disable switch is unset or empty', () => {
    expect(resolveTelemetryPatch(undefined, true)).toBeUndefined()
    expect(resolveTelemetryPatch('', true)).toBeUndefined()
  })

  it('disables on ANY non-empty value, including falsy-looking ones', () => {
    for (const value of ['1', '0', 'false', 'no']) {
      expect(resolveTelemetryPatch(value, true)).toEqual({ id: 'session-telemetry-otel', disabled: true })
    }
  })

  it('is trivially satisfied by a composition without the telemetry row', () => {
    // A custom profile need not mount telemetry: nothing exports, so the
    // privacy switch has nothing to disable and generates no patch.
    expect(resolveTelemetryPatch('1', false)).toBeUndefined()
    expect(resolveTelemetryPatch(undefined, false)).toBeUndefined()
  })
})

describe('shouldWatchUserPatches', () => {
  const capability = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

  it('disables Node-internals-dependent patch watching only for a supervised desktop launch', () => {
    expect(shouldWatchUserPatches('desktop', {
      DSH_DESKTOP_APP_VERSION: '0.1.0-rc.7',
      DSH_DESKTOP_CAPABILITY: capability,
    })).toBe(false)
  })

  it.each([
    ['desktop', {}],
    ['desktop', { DSH_DESKTOP_APP_VERSION: '0.1.0-rc.7', DSH_DESKTOP_CAPABILITY: 'short' }],
    ['web', { DSH_DESKTOP_CAPABILITY: capability }],
    ['headless', { DSH_DESKTOP_CAPABILITY: capability }],
  ])('keeps patch watching for an unsupervised or non-desktop profile %#', (profile, environment) => {
    expect(shouldWatchUserPatches(profile, environment)).toBe(true)
  })
})
