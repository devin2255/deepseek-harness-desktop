/** Required validation-provider identity for continuable owned execution. @module @deepseek-ai/dsh-subagent/execution-provider */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from './types.ts'

/**
 * Read the unique required execution provider from a child's own events.
 * @param events - own log suffix, excluding inherited fork history.
 * @returns provider identity, or undefined for ordinary shared execution.
 * @throws when the durable provider record is malformed or repeated.
 */
export function executionProviderOf(events: readonly SessionEvent[]): string | undefined {
  const records = events.filter(event => event.type === 'subagent/execution-provider')
  const [record] = records
  if (record === undefined) return undefined
  if (records.length !== 1) throw new Error('subagent execution provider must be recorded exactly once')
  const data: unknown = record.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)
    || Object.keys(data).join(',') !== 'provider') {
    throw new Error('subagent execution data must have exactly the provider field')
  }
  const provider = (data as Record<string, unknown>)['provider']
  if (typeof provider !== 'string' || provider.length === 0 || provider !== provider.trim()) {
    throw new Error('subagent execution provider must be non-empty and normalized')
  }
  return provider
}
