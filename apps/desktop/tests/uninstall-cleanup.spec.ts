import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isUninstallCleanupInvocation,
  UNINSTALL_CLEANUP_ENVIRONMENT_KEY,
  runUninstallCleanup,
} from '../src/uninstall-cleanup.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGH012345678'

function invoke(appData: string, argv: readonly string[] = [`--uninstall-delete-user-data=${TOKEN}`], token = TOKEN) {
  return runUninstallCleanup({
    argv,
    environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: token },
  })
}

describe('runUninstallCleanup', () => {
  it('routes malformed cleanup switches into rejection instead of normal desktop startup', () => {
    expect(isUninstallCleanupInvocation(['--uninstall-delete-user-data='])).toBe(true)
    expect(isUninstallCleanupInvocation([`--uninstall-delete-user-data=${TOKEN}`, '--extra'])).toBe(true)
    expect(isUninstallCleanupInvocation([])).toBe(false)
    expect(isUninstallCleanupInvocation(['--ordinary-desktop-argument'])).toBe(false)
  })

  it('deletes only the fixed product root after both confirmation channels match', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(join(appData, 'sibling.txt'), 'keep')

    await expect(invoke(appData)).resolves.toBe(true)

    expect(() => readFileSync(join(product, 'owned.txt'))).toThrow()
    expect(readFileSync(join(appData, 'sibling.txt'), 'utf8')).toBe('keep')
  })

  it.each([
    [[], TOKEN],
    [[`--uninstall-delete-user-data=${TOKEN}`], undefined],
    [[`--uninstall-delete-user-data=${TOKEN}`], 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh012345678'],
    [['--uninstall-delete-user-data='], TOKEN],
    [[`--uninstall-delete-user-data=${TOKEN}`, '--extra'], TOKEN],
    [[`--uninstall-delete-user-data=${TOKEN}`, `--uninstall-delete-user-data=${TOKEN}`], TOKEN],
  ] as const)('rejects absent, mismatched, empty, duplicate, or augmented cleanup authorization', async (argv, token) => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-auth-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'sentinel.txt'), 'keep')

    await expect(runUninstallCleanup({
      argv,
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: token },
    })).rejects.toThrow(/cleanup request|confirmation/iu)
    expect(readFileSync(join(product, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it.each(['', '.', parse(process.cwd()).root])('rejects unsafe APPDATA value %j without deleting data', async (appData) => {
    await expect(invoke(appData)).rejects.toThrow(/APPDATA/iu)
  })

  it('rejects a linked APPDATA ancestor and preserves the external sentinel', async () => {
    const base = mkdtempSync(join(tmpdir(), 'dsh-cleanup-link-'))
    const external = join(base, 'external')
    const linked = join(base, 'linked')
    mkdirSync(external)
    symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const product = join(external, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'sentinel.txt'), 'keep')

    await expect(invoke(linked)).rejects.toThrow(/link|reparse/iu)
    expect(readFileSync(join(product, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('rejects a linked product root and preserves the external sentinel', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-root-link-'))
    const external = mkdtempSync(join(tmpdir(), 'dsh-cleanup-external-'))
    writeFileSync(join(external, 'sentinel.txt'), 'keep')
    symlinkSync(external, join(appData, 'DeepSeek Harness'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(invoke(appData)).rejects.toThrow(/link|reparse/iu)
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('does not include either confirmation token in an authorization error', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-secret-'))
    const other = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgh012345678'
    let failure: unknown
    try {
      await invoke(appData, [`--uninstall-delete-user-data=${TOKEN}`], other)
    } catch (error: unknown) {
      failure = error
    }

    expect(String(failure)).not.toContain(TOKEN)
    expect(String(failure)).not.toContain(other)
  })
})
