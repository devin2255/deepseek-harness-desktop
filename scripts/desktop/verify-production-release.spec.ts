import { describe, expect, it } from 'vitest'

import {
  assertProductionReleaseTag,
  assertProductionSignature,
} from './verify-production-release.ts'

describe('desktop production release gate', () => {
  it('accepts only the exact version tag', () => {
    expect(() => { assertProductionReleaseTag('dsh-v0.1.0-rc.7', '0.1.0-rc.7') }).not.toThrow()
    for (const tag of [undefined, 'v0.1.0-rc.7', 'dsh-v0.1.0-rc.6', 'dsh-v0.1.0-rc.7-extra']) {
      expect(() => { assertProductionReleaseTag(tag, '0.1.0-rc.7') }).toThrow(/expected tag/u)
    }
  })

  it('requires an Authenticode-valid installer and installed application', () => {
    expect(() => { assertProductionSignature('installer', { signed: true, signatureStatus: 'Valid' }) }).not.toThrow()
    expect(() => { assertProductionSignature('installer', { signed: false, signatureStatus: 'NotSigned' }) })
      .toThrow(/installer is not Authenticode-valid/u)
    expect(() => { assertProductionSignature('installed application', { signed: true, signatureStatus: 'UnknownError' }) })
      .toThrow(/installed application is not Authenticode-valid/u)
  })
})
