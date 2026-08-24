import { describe, expect, it } from 'vitest'
import {
  createStartupState,
  reduceStartup,
  type DesktopStartupEvent,
  type DesktopStartupState,
} from '../src/startup-state.ts'

describe('desktop startup state', () => {
  it('advances through the fixed startup phases', () => {
    const events: readonly DesktopStartupEvent[] = [
      { type: 'electron-ready', attempt: 1 },
      { type: 'runtime-loaded', attempt: 1 },
      { type: 'profile-validated', attempt: 1 },
      { type: 'service-started', attempt: 1 },
      { type: 'service-ready', attempt: 1 },
    ]

    const states = events.reduce<DesktopStartupState[]>(
      (history, event) => [...history, reduceStartup(history.at(-1) ?? createStartupState(1), event)],
      [createStartupState(1)],
    )

    expect(states.map(state => state.phase)).toEqual([
      'waiting-electron',
      'loading-runtime',
      'validating-profile',
      'starting-service',
      'probing-service',
      'ready',
    ])
  })

  it('retries a failed startup with a new attempt', () => {
    const failed = reduceStartup(
      { attempt: 1, phase: 'probing-service', status: 'working' },
      { type: 'failed', attempt: 1, error: new Error('connection refused') },
    )

    expect(reduceStartup(failed, { type: 'retry', attempt: 2 })).toEqual({
      attempt: 2,
      phase: 'loading-runtime',
      status: 'working',
    })
  })

  it('ignores updates from a stale attempt', () => {
    const current: DesktopStartupState = {
      attempt: 2,
      phase: 'starting-service',
      status: 'working',
    }

    expect(reduceStartup(current, { type: 'service-started', attempt: 1 })).toBe(current)
    expect(reduceStartup(current, { type: 'failed', attempt: 1, error: new Error('old failure') })).toBe(current)
  })

  it('projects failures to a stable code and short action without diagnostic details', () => {
    const apiKey = 'sk-secret-api-key'
    const capability = 'private-desktop-capability'
    const repositoryPath = String.raw`D:\vibe_coding\deepseek-harness-desktop\packages\api\src\index.ts`
    const error = new Error(
      `Bearer ${capability} failed for ${repositoryPath}; DEEPSEEK_API_KEY=${apiKey}`,
    )
    error.stack = `${error.message}\n    at ${repositoryPath}:12:4`

    const failed = reduceStartup(
      { attempt: 3, phase: 'probing-service', status: 'working' },
      { type: 'failed', attempt: 3, error },
    )

    expect(failed).toEqual({
      attempt: 3,
      phase: 'failed',
      status: 'failed',
      error: {
        code: 'service-unreachable',
        action: 'Retry startup. If the problem continues, open the desktop log.',
      },
    })
    expect(JSON.stringify(failed)).not.toMatch(/stack|capability|sk-secret|Bearer|vibe_coding/iu)
  })
})
