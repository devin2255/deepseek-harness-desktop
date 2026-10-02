import { describe, expect, it } from 'vitest'
import { requireDesktopUpdatePublisher } from '../src/update-config.ts'

const signedConfig = [
  'provider: github',
  'owner: devin2255',
  'repo: deepseek-harness-desktop',
  "updaterCacheDirName: '@deepseek-aidsh-desktop-updater'",
  'publisherName:',
  '  - DeepSeek Harness Publisher',
  '',
].join('\n')

describe('packaged desktop update configuration', () => {
  it('enables only the reviewed signed release source', () => {
    expect(requireDesktopUpdatePublisher(signedConfig)).toBe('DeepSeek Harness Publisher')
  })

  it.each([
    signedConfig.replace('publisherName:\n  - DeepSeek Harness Publisher\n', ''),
    signedConfig.replace('devin2255', 'other-owner'),
    signedConfig.replace('deepseek-harness-desktop', 'other-repository'),
    signedConfig.replace('github', 'generic'),
    `${signedConfig}host: other.example\n`,
    signedConfig.replace('DeepSeek Harness Publisher', '""'),
  ])('rejects unsigned or foreign package settings', (contents) => {
    expect(() => requireDesktopUpdatePublisher(contents)).toThrow(/reviewed signed release configuration/u)
  })
})
