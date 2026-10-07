/** Durable owned-execution provider decoding. */

import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { executionProviderOf } from '../src/execution-provider.ts'

const record = (data: unknown) => ({ type: 'subagent/execution-provider', data }) as SessionEvent

it('distinguishes ordinary execution from one recorded owner', () => {
  expect(executionProviderOf([])).toBeUndefined()
  expect(executionProviderOf([record({ provider: 'writer' })])).toBe('writer')
})

it.each([null, [], 'writer', {}, { provider: 'writer', extra: true }, { provider: '' }, { provider: ' writer' }, { provider: 1 }])(
  'rejects malformed persisted owner %j', (data) => {
    expect(() => executionProviderOf([record(data)])).toThrow()
  },
)

it('rejects duplicate owner records even when names agree', () => {
  expect(() => executionProviderOf([record({ provider: 'writer' }), record({ provider: 'writer' })])).toThrow('exactly once')
})
