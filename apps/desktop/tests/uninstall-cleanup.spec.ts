import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { rmdir, unlink, utimes } from 'node:fs/promises'
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
    maxSnapshotEntries: 100,
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
    expect(transactionArtifacts(appData)).toEqual([])
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
      maxSnapshotEntries: 100,
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

  it.each(['unlink', 'rmdir'] as const)('keeps every canonical file intact when snapshot %s validation fails', async (operation) => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-atomic-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(join(product, 'nested'), { recursive: true })
    writeFileSync(join(product, 'first.txt'), 'first')
    writeFileSync(join(product, 'nested', 'second.txt'), 'second')
    let calls = 0

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, operation === 'unlink'
      ? {
        unlink: async (path) => {
          calls += 1
          if (calls === 2) throw new Error('injected second unlink failure')
          await unlink(path)
        },
      }
      : {
        rmdir: async (path) => {
          calls += 1
          if (calls === 1) throw new Error('injected rmdir failure')
          await rmdir(path)
        },
      })).rejects.toThrow(/validation/iu)

    expect(readFileSync(join(product, 'first.txt'), 'utf8')).toBe('first')
    expect(readFileSync(join(product, 'nested', 'second.txt'), 'utf8')).toBe('second')
  })

  it('rejects an oversized rollback snapshot before moving the canonical tree', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-limit-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'large.txt'), 'too-large')

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 1,
    })).rejects.toThrow(/snapshot/iu)
    expect(readFileSync(join(product, 'large.txt'), 'utf8')).toBe('too-large')
  })

  it('does not follow an external link when snapshot validation and cleanup both fail', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-restore-failure-'))
    const product = join(appData, 'DeepSeek Harness')
    const external = mkdtempSync(join(tmpdir(), 'dsh-cleanup-restore-external-'))
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(join(external, 'sentinel.txt'), 'keep')
    symlinkSync(external, join(product, 'external'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      unlink: async () => { throw new Error('injected snapshot cleanup failure') },
    })).rejects.toThrow(/link|junction|reparse/iu)

    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('leaves the canonical tree intact when the atomic commit rename fails', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-commit-failure-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      rename: async () => { throw new Error('injected commit rename failure') },
    })).rejects.toThrow(/commit/iu)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
  })

  it('restores canonical contents and directory structure when tombstone deletion fails', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-tombstone-failure-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(join(product, 'nested'), { recursive: true })
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(join(product, 'nested', 'second.txt'), 'second')

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      rmdir: async (path) => {
        if (String(path).includes('uninstall-tombstone')) throw new Error('injected tombstone rmdir failure')
        await rmdir(path)
      },
    })).rejects.toThrow(/restored|transaction/iu)

    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(join(product, 'nested', 'second.txt'), 'utf8')).toBe('second')
  })

  it('restores historical file and directory mtime and supported mode before publishing rollback', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-metadata-'))
    const product = join(appData, 'DeepSeek Harness')
    const nested = join(product, 'nested')
    const owned = join(nested, 'owned.txt')
    mkdirSync(nested, { recursive: true })
    writeFileSync(owned, 'owned')
    const historicalFileTime = new Date('2020-01-02T03:04:05.000Z')
    const historicalDirectoryTime = new Date('2020-02-03T04:05:06.000Z')
    chmodSync(owned, 0o640)
    chmodSync(nested, 0o750)
    utimesSync(owned, historicalFileTime, historicalFileTime)
    utimesSync(nested, historicalDirectoryTime, historicalDirectoryTime)

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      rmdir: async (path) => {
        if (String(path).includes('uninstall-tombstone')) throw new Error('injected tombstone rmdir failure')
        await rmdir(path)
      },
    })).rejects.toThrow(/restored|transaction/iu)

    const restoredFile = statSync(owned)
    const restoredDirectory = statSync(nested)
    expect(restoredFile.mtimeMs).toBeCloseTo(historicalFileTime.getTime(), -1)
    expect(restoredDirectory.mtimeMs).toBeCloseTo(historicalDirectoryTime.getTime(), -1)
    if (process.platform !== 'win32') {
      expect(restoredFile.mode & 0o777).toBe(0o640)
      expect(restoredDirectory.mode & 0o777).toBe(0o750)
    }
  })

  it('does not publish a rollback tree when restoring its metadata fails', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-metadata-failure-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      rmdir: async (path) => {
        if (String(path).includes('uninstall-tombstone')) throw new Error('injected tombstone rmdir failure')
        await rmdir(path)
      },
      utimes: async (path, atime, mtime) => {
        if (String(path).includes('uninstall-restore')) throw new Error('injected restore metadata failure')
        await utimes(path, atime, mtime)
      },
    })).rejects.toThrow(/fatal.*recovery/iu)

    expect(() => lstatSync(product)).toThrow()
    expect(transactionArtifacts(appData).some(name => name.includes('uninstall-archive'))).toBe(true)
  })

  it('restores canonical contents and directory structure when final archive unlink fails', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-archive-failure-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(join(product, 'nested'), { recursive: true })
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(join(product, 'nested', 'second.txt'), 'second')

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      unlink: async (path) => {
        if (String(path).includes('uninstall-archive')) throw new Error('injected final archive unlink failure')
        await unlink(path)
      },
    })).rejects.toThrow(/restored|transaction/iu)

    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(join(product, 'nested', 'second.txt'), 'utf8')).toBe('second')
  })

  it('rejects any descendant link before mutation and preserves the external target', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-descendant-link-'))
    const product = join(appData, 'DeepSeek Harness')
    const external = mkdtempSync(join(tmpdir(), 'dsh-cleanup-descendant-external-'))
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(join(external, 'sentinel.txt'), 'keep')
    symlinkSync(external, join(product, 'external'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(invoke(appData)).rejects.toThrow(/link|junction|reparse/iu)

    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('recovers an authenticated interrupted transaction before starting a fresh cleanup', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-interrupted-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    let savedArchive: string | undefined

    await expect(runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      rename: async () => {
        const archive = transactionArtifacts(appData).find(name => name.includes('uninstall-archive'))
        if (archive === undefined) throw new Error('archive was not created')
        savedArchive = join(appData, 'saved-archive')
        copyFileSync(join(appData, archive), savedArchive)
        throw new Error('simulated interruption before commit')
      },
    })).rejects.toThrow(/commit/iu)

    const transactionId = '0123456789abcdef0123456789abcdef'
    const archive = join(appData, `.DeepSeek Harness.uninstall-archive-${transactionId}`)
    const tombstone = join(appData, `.DeepSeek Harness.uninstall-tombstone-${transactionId}`)
    copyFileSync(savedArchive!, archive)
    const bytes = readFileSync(archive)
    Buffer.from(transactionId, 'ascii').copy(bytes, 8)
    writeFileSync(archive, bytes)
    renameSync(product, tombstone)

    await expect(invoke(appData)).resolves.toBe(true)
    expect(transactionArtifacts(appData)).toEqual([])
  })

  it('does not touch an unknown file that imitates a transaction archive name', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-unknown-archive-'))
    const product = join(appData, 'DeepSeek Harness')
    const archive = join(appData, '.DeepSeek Harness.uninstall-archive-0123456789abcdef0123456789abcdef')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(archive, 'not an owned transaction')

    await expect(invoke(appData)).rejects.toThrow(/archive/iu)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(archive, 'utf8')).toBe('not an owned transaction')
  })

  it('does not follow an unknown link that imitates a transaction archive name', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-unknown-archive-link-'))
    const product = join(appData, 'DeepSeek Harness')
    const external = mkdtempSync(join(tmpdir(), 'dsh-cleanup-unknown-archive-target-'))
    const archive = join(appData, '.DeepSeek Harness.uninstall-archive-0123456789abcdef0123456789abcdef')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(join(external, 'sentinel.txt'), 'keep')
    symlinkSync(join(external, 'sentinel.txt'), archive, 'file')

    await expect(invoke(appData)).rejects.toThrow(/archive/iu)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it.each([
    ['tombstone', 'directory', false],
    ['tombstone', 'file', true],
    ['tombstone', 'link', false],
    ['validation', 'directory', true],
    ['validation', 'file', false],
    ['validation', 'link', true],
    ['restore', 'directory', false],
    ['restore', 'file', true],
    ['restore', 'link', false],
  ] as const)('rejects and preserves an orphan %s %s artifact', async (kind, artifactType, canonicalExists) => {
    const appData = mkdtempSync(join(tmpdir(), `dsh-cleanup-orphan-${kind}-${artifactType}-`))
    const product = join(appData, 'DeepSeek Harness')
    const external = mkdtempSync(join(tmpdir(), 'dsh-cleanup-orphan-target-'))
    const transactionId = '0123456789abcdef0123456789abcdef'
    const suffix = kind === 'restore' ? `${transactionId}-0123456789abcdef` : transactionId
    const artifact = join(appData, `.DeepSeek Harness.uninstall-${kind}-${suffix}`)
    if (canonicalExists) {
      mkdirSync(product)
      writeFileSync(join(product, 'owned.txt'), 'owned')
    }
    writeFileSync(join(external, 'sentinel.txt'), 'keep')
    if (artifactType === 'directory') {
      mkdirSync(artifact)
      writeFileSync(join(artifact, 'artifact.txt'), 'artifact')
    } else if (artifactType === 'file') {
      writeFileSync(artifact, 'artifact')
    } else {
      symlinkSync(external, artifact, process.platform === 'win32' ? 'junction' : 'dir')
    }

    await expect(invoke(appData)).rejects.toThrow(/artifact|transaction/iu)
    if (canonicalExists) expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    if (artifactType === 'directory') expect(readFileSync(join(artifact, 'artifact.txt'), 'utf8')).toBe('artifact')
    else if (artifactType === 'file') expect(readFileSync(artifact, 'utf8')).toBe('artifact')
    else expect(lstatSync(artifact).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(external, 'sentinel.txt'), 'utf8')).toBe('keep')
  })

  it('rejects a malformed reserved artifact name without deleting canonical data', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-malformed-artifact-'))
    const product = join(appData, 'DeepSeek Harness')
    const artifact = join(appData, '.DeepSeek Harness.uninstall-tombstone-not-a-transaction')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    writeFileSync(artifact, 'unknown')

    await expect(invoke(appData)).rejects.toThrow(/artifact|transaction/iu)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(readFileSync(artifact, 'utf8')).toBe('unknown')
  })

  it('rejects duplicate restore artifacts without touching either directory', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-duplicate-artifact-'))
    const transactionId = '0123456789abcdef0123456789abcdef'
    const first = join(appData, `.DeepSeek Harness.uninstall-restore-${transactionId}-0123456789abcdef`)
    const second = join(appData, `.DeepSeek Harness.uninstall-restore-${transactionId}-fedcba9876543210`)
    mkdirSync(first)
    mkdirSync(second)
    writeFileSync(join(first, 'first.txt'), 'first')
    writeFileSync(join(second, 'second.txt'), 'second')

    await expect(invoke(appData)).rejects.toThrow(/duplicate/iu)
    expect(readFileSync(join(first, 'first.txt'), 'utf8')).toBe('first')
    expect(readFileSync(join(second, 'second.txt'), 'utf8')).toBe('second')
  })

  it('rejects conflicting transaction ids without touching either artifact', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-conflicting-artifact-'))
    const tombstone = join(appData, '.DeepSeek Harness.uninstall-tombstone-0123456789abcdef0123456789abcdef')
    const validation = join(appData, '.DeepSeek Harness.uninstall-validation-fedcba9876543210fedcba9876543210')
    mkdirSync(tombstone)
    mkdirSync(validation)
    writeFileSync(join(tombstone, 'tombstone.txt'), 'tombstone')
    writeFileSync(join(validation, 'validation.txt'), 'validation')

    await expect(invoke(appData)).rejects.toThrow(/conflicting/iu)
    expect(readFileSync(join(tombstone, 'tombstone.txt'), 'utf8')).toBe('tombstone')
    expect(readFileSync(join(validation, 'validation.txt'), 'utf8')).toBe('validation')
  })

  it.each([
    ['unknown archive version', (bytes: Buffer) => { bytes.write('DSHUA999', 0, 'ascii'); return bytes }, /identity/iu],
    ['oversized path metadata', (bytes: Buffer) => { bytes.writeUInt32BE(1_048_577, 57); return bytes }, /metadata limit/iu],
    ['truncated header', (bytes: Buffer) => bytes.subarray(0, 45), /truncated/iu],
    ['truncated file content', (bytes: Buffer) => bytes.subarray(0, bytes.length - 20), /truncated/iu],
    ['entry count above the configured limit', (bytes: Buffer) => { bytes.writeUInt32BE(101, 40); return bytes }, /entry count/iu],
    ['invalid root metadata', (bytes: Buffer) => { bytes.writeDoubleBE(Number.NaN, 48); return bytes }, /metadata/iu],
    ['unsafe file content length', (bytes: Buffer) => {
      const pathLength = bytes.readUInt32BE(57)
      bytes.writeBigUInt64BE(0xffff_ffff_ffff_ffffn, 56 + 5 + pathLength + 12)
      return bytes
    }, /truncated|too large/iu],
  ] as const)('rejects %s without touching canonical data or the archive', async (_name, mutate, expected) => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-malformed-archive-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    const archive = await stageArchive(appData)
    writeFileSync(archive, mutate(readFileSync(archive)))

    await expect(invoke(appData)).rejects.toThrow(expected)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(lstatSync(archive).isFile()).toBe(true)
  })

  it('rejects duplicate archive records without touching canonical data or the archive', async () => {
    const appData = mkdtempSync(join(tmpdir(), 'dsh-cleanup-duplicate-record-'))
    const product = join(appData, 'DeepSeek Harness')
    mkdirSync(product)
    writeFileSync(join(product, 'owned.txt'), 'owned')
    const archive = await stageArchive(appData)
    const bytes = readFileSync(archive)
    const recordStart = 56
    const pathLength = bytes.readUInt32BE(recordStart + 1)
    const contentLengthOffset = recordStart + 5 + pathLength + 12
    const contentLength = Number(bytes.readBigUInt64BE(contentLengthOffset))
    const recordEnd = contentLengthOffset + 8 + contentLength + 32
    const duplicated = Buffer.concat([
      bytes.subarray(0, recordEnd),
      bytes.subarray(recordStart, recordEnd),
      bytes.subarray(recordEnd),
    ])
    duplicated.writeUInt32BE(3, 40)
    writeFileSync(archive, duplicated)

    await expect(invoke(appData)).rejects.toThrow(/duplicate/iu)
    expect(readFileSync(join(product, 'owned.txt'), 'utf8')).toBe('owned')
    expect(lstatSync(archive).isFile()).toBe(true)
  })
})

async function stageArchive(appData: string): Promise<string> {
  const transactionId = '0123456789abcdef0123456789abcdef'
  let savedArchive: Buffer | undefined
  try {
    await runUninstallCleanup({
      argv: [`--uninstall-delete-user-data=${TOKEN}`],
      environment: { APPDATA: appData, [UNINSTALL_CLEANUP_ENVIRONMENT_KEY]: TOKEN },
      maxSnapshotEntries: 100,
    }, {
      rename: async () => {
        const archiveName = transactionArtifacts(appData).find(name => name.includes('uninstall-archive'))
        if (archiveName === undefined) throw new Error('archive was not created')
        savedArchive = readFileSync(join(appData, archiveName))
        throw new Error('capture archive before commit')
      },
    })
  } catch { /* The injected commit failure leaves canonical data unchanged. */ }
  if (savedArchive === undefined) throw new Error('failed to capture uninstall archive')
  const archive = join(appData, `.DeepSeek Harness.uninstall-archive-${transactionId}`)
  Buffer.from(transactionId, 'ascii').copy(savedArchive, 8)
  writeFileSync(archive, savedArchive)
  return archive
}

function transactionArtifacts(appData: string): string[] {
  return readdirSync(appData).filter(name => name.startsWith('.DeepSeek Harness.uninstall-'))
}
