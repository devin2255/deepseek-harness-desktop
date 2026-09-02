import { describe, expect, it } from 'vitest'
import { isInstallerCloseNotification } from '../src/installer-close-intent.ts'

describe('installer close notifications', () => {
  it('accepts only the exact deserialized close notification', () => {
    expect(isInstallerCloseNotification({ type: 'deepseek-harness:installer-close' })).toBe(true)
  })

  it.each([
    undefined, null, false, 'deepseek-harness:installer-close', [], {},
    { type: 'other' },
    { type: 'deepseek-harness:installer-close', unexpected: true },
  ])('rejects malformed notification %j', (notification) => {
    expect(isInstallerCloseNotification(notification)).toBe(false)
  })
})
