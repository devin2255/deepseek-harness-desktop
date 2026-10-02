import { describe, expect, it, vi } from 'vitest'
import { disposeTogether, subscribeTogether } from '../src/client/lifecycle.ts'

describe('client lifecycle composition', () => {
  it('releases every registration and preserves single cleanup failures', () => {
    const first = vi.fn()
    const failure = new Error('cleanup failed')
    const second = vi.fn(() => { throw failure })
    const third = vi.fn()

    expect(() => {
      disposeTogether([first, second, third], 'cleanup failures')()
    }).toThrow(failure)
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
    expect(third).toHaveBeenCalledOnce()
  })

  it('reports multiple cleanup failures in callback order', () => {
    const firstFailure = new Error('first cleanup failed')
    const secondFailure = new Error('second cleanup failed')

    expect(() => {
      disposeTogether([
        () => { throw firstFailure },
        () => { throw secondFailure },
      ], 'cleanup failures')()
    }).toThrow(expect.objectContaining({
      message: 'cleanup failures',
      cause: firstFailure,
      errors: [firstFailure, secondFailure],
    }))
  })

  it('returns a successful combined cleanup after every subscription installs', () => {
    const first = vi.fn()
    const second = vi.fn()
    const dispose = subscribeTogether([
      () => first,
      () => second,
    ], 'subscription cleanup failed')

    dispose()
    expect(first).toHaveBeenCalledOnce()
    expect(second).toHaveBeenCalledOnce()
  })

  it('rolls back installed subscriptions and preserves the registration failure', () => {
    const release = vi.fn()
    const failure = new Error('subscription failed')

    expect(() => {
      subscribeTogether([
        () => release,
        () => { throw failure },
      ], 'subscription cleanup failed')
    }).toThrow(failure)
    expect(release).toHaveBeenCalledOnce()
  })

  it('reports registration and rollback failures together', () => {
    const registrationFailure = new Error('subscription failed')
    const rollbackFailure = new Error('rollback failed')

    expect(() => {
      subscribeTogether([
        () => () => { throw rollbackFailure },
        () => { throw registrationFailure },
      ], 'subscription cleanup failed')
    }).toThrow(expect.objectContaining({
      message: 'subscription cleanup failed',
      cause: registrationFailure,
      errors: [registrationFailure, rollbackFailure],
    }))
  })
})
