import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopLog } from '../src/desktop-log.ts'
import { redactSensitiveText } from '../src/sensitive-text-redactor.ts'

const temporaryDirectories: string[] = []
const INPUT_LIMITS = { maxMessageCodeUnits: 20_000, maxMetadataCodeUnits: 128 } as const

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeLogDirectory(): string {
  return join(makeTemporaryRoot(), 'owned', 'logs')
}

function makeTemporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-'))
  temporaryDirectories.push(root)
  return root
}

function lifecycleEvent(message: string) {
  return { timestamp: '2026-08-24T08:00:00.000Z', type: 'loading-runtime', message }
}

describe('DesktopLog', () => {
  it('creates the owned directory and appends one redacted JSON line per lifecycle event', () => {
    const directory = makeLogDirectory()
    const secret = 'sk-private-value'
    const log = new DesktopLog({ directory, maxBytes: 4_096, sensitiveValues: [secret], ...INPUT_LIMITS })

    log.append({ timestamp: '2026-08-24T08:00:00.000Z', type: 'loading-runtime', message: `using ${secret}` })
    log.append({ timestamp: '2026-08-24T08:00:01.000Z', type: 'runtime-loaded', message: 'runtime ready' })

    const lines = readFileSync(log.currentPath(), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
    expect(log.currentPath()).toBe(resolve(directory, 'desktop.log'))
    expect(lines).toEqual([
      { timestamp: '2026-08-24T08:00:00.000Z', type: 'loading-runtime', message: 'using [redacted]' },
      { timestamp: '2026-08-24T08:00:01.000Z', type: 'runtime-loaded', message: 'runtime ready' },
    ])
    expect(readFileSync(log.currentPath(), 'utf8')).not.toContain(secret)
  })

  it('rotates before an appended line would reach the configured byte threshold', () => {
    const directory = makeLogDirectory()
    const first = { timestamp: '2026-08-24T08:00:00.000Z', type: 'phase', message: 'first lifecycle event' }
    const second = { timestamp: '2026-08-24T08:00:01.000Z', type: 'phase', message: 'second lifecycle event' }
    const firstBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`)
    const secondBytes = Buffer.byteLength(`${JSON.stringify(second)}\n`)
    const log = new DesktopLog({ directory, maxBytes: firstBytes + secondBytes, sensitiveValues: [], ...INPUT_LIMITS })

    log.append(first)
    log.append(second)

    expect(readFileSync(log.currentPath(), 'utf8')).toBe(`${JSON.stringify(second)}\n`)
  })

  it('rejects invalid rotation thresholds instead of supplying an implicit tuning default', () => {
    expect(() => new DesktopLog({ directory: makeLogDirectory(), maxBytes: 0, sensitiveValues: [], ...INPUT_LIMITS })).toThrow(
      'maxBytes must be a positive integer',
    )
    expect(() => new DesktopLog({ directory: makeLogDirectory(), maxBytes: 64, sensitiveValues: [], ...INPUT_LIMITS })).toThrow(
      'too small',
    )
    expect(() => new DesktopLog({
      directory: makeLogDirectory(),
      maxBytes: 4_096,
      sensitiveValues: [],
      maxMessageCodeUnits: 0,
      maxMetadataCodeUnits: 128,
    })).toThrow('maxMessageCodeUnits must be a positive integer')
    expect(() => new DesktopLog({
      directory: makeLogDirectory(),
      maxBytes: 4_096,
      sensitiveValues: [],
      maxMessageCodeUnits: 128,
      maxMetadataCodeUnits: Number.POSITIVE_INFINITY,
    })).toThrow('maxMetadataCodeUnits must be a positive integer')
  })

  it('rejects a current-log file link without modifying its external target', () => {
    const directory = makeLogDirectory()
    const log = new DesktopLog({ directory, maxBytes: 4_096, sensitiveValues: [], ...INPUT_LIMITS })
    const external = join(temporaryDirectories[0] ?? tmpdir(), 'external-current.log')
    writeFileSync(external, 'sentinel', 'utf8')
    symlinkSync(external, log.currentPath(), 'file')

    expect(() => log.append(lifecycleEvent('must not escape'))).toThrow(/symbolic link|junction/iu)
    expect(readFileSync(external, 'utf8')).toBe('sentinel')
  })

  it('rejects a rotated-log file link without removing it or modifying its target', () => {
    const directory = makeLogDirectory()
    const external = join(temporaryDirectories[0] ?? tmpdir(), 'external-rotated.log')
    writeFileSync(external, 'sentinel', 'utf8')
    const first = lifecycleEvent('first lifecycle event')
    const second = lifecycleEvent('second lifecycle event')
    const maxBytes = Buffer.byteLength(`${JSON.stringify(first)}\n`) + Buffer.byteLength(`${JSON.stringify(second)}\n`)
    const log = new DesktopLog({ directory, maxBytes, sensitiveValues: [], ...INPUT_LIMITS })
    log.append(first)
    symlinkSync(external, join(directory, 'desktop.log.1'), 'file')

    expect(() => log.append(second)).toThrow(/symbolic link|junction/iu)
    expect(readFileSync(external, 'utf8')).toBe('sentinel')
    expect(readFileSync(join(directory, 'desktop.log.1'), 'utf8')).toBe('sentinel')
  })

  it('rejects an existing log-directory junction without modifying its external target', () => {
    const root = makeTemporaryRoot()
    const externalDirectory = join(root, 'external-directory')
    const linkedDirectory = join(root, 'linked-logs')
    mkdirSync(externalDirectory)
    writeFileSync(join(externalDirectory, 'desktop.log'), 'sentinel', 'utf8')
    symlinkSync(externalDirectory, linkedDirectory, 'junction')

    expect(() => new DesktopLog({ directory: linkedDirectory, maxBytes: 4_096, sensitiveValues: [], ...INPUT_LIMITS })).toThrow(
      /symbolic link|junction/iu,
    )
    expect(readFileSync(join(externalDirectory, 'desktop.log'), 'utf8')).toBe('sentinel')
  })

  it('rejects a junction in an existing ancestor of the log directory', () => {
    const root = makeTemporaryRoot()
    const externalDirectory = join(root, 'external-parent')
    const linkedParent = join(root, 'linked-parent')
    mkdirSync(externalDirectory)
    symlinkSync(externalDirectory, linkedParent, 'junction')

    expect(() => new DesktopLog({
      directory: join(linkedParent, 'logs'),
      maxBytes: 4_096,
      sensitiveValues: [],
      ...INPUT_LIMITS,
    })).toThrow(
      /symbolic link|junction/iu,
    )
    expect(() => statSync(join(externalDirectory, 'logs'))).toThrow()
  })

  it('bounds an oversized record after redaction and preserves lifecycle metadata', () => {
    const directory = makeLogDirectory()
    const secret = 'secret-value-that-must-be-redacted'
    const log = new DesktopLog({ directory, maxBytes: 256, sensitiveValues: [secret], ...INPUT_LIMITS })

    log.append(lifecycleEvent(`${secret}${'x'.repeat(10_000)}`))

    const persisted = readFileSync(log.currentPath(), 'utf8')
    const record = JSON.parse(persisted)
    expect(statSync(log.currentPath()).size).toBeLessThanOrEqual(256)
    expect(persisted.endsWith('\n')).toBe(true)
    expect(persisted.trimEnd().split('\n')).toHaveLength(1)
    expect(record).toMatchObject({
      timestamp: '2026-08-24T08:00:00.000Z',
      type: 'loading-runtime',
      truncated: true,
    })
    expect(persisted).not.toContain(secret)
  })

  it('truncates multi-byte Unicode only at a valid JSON string boundary', () => {
    const directory = makeLogDirectory()
    const log = new DesktopLog({ directory, maxBytes: 240, sensitiveValues: [], ...INPUT_LIMITS })

    log.append(lifecycleEvent('诊断🚀'.repeat(1_000)))

    const persisted = readFileSync(log.currentPath(), 'utf8')
    const record = JSON.parse(persisted)
    expect(statSync(log.currentPath()).size).toBeLessThanOrEqual(240)
    expect(record.truncated).toBe(true)
    expect(record.message).not.toContain('\uFFFD')
  })

  it('suppresses an over-limit message before passing fixed text to the redactor', () => {
    const directory = makeLogDirectory()
    const redactedInputs: string[] = []
    const secret = 'secret-at-input-tail'
    const message = `input-start-${'x'.repeat(5_000_000)}-${secret}`
    const log = new DesktopLog(
      {
        directory,
        maxBytes: 256,
        sensitiveValues: [secret],
        maxMessageCodeUnits: 1_024,
        maxMetadataCodeUnits: 128,
      },
      {
        redactText: (text, patterns) => {
          redactedInputs.push(text)
          return redactSensitiveText(text, patterns)
        },
      },
    )

    log.append(lifecycleEvent(message))

    const persisted = readFileSync(log.currentPath(), 'utf8')
    expect(redactedInputs).toEqual(['[message suppressed: input limit exceeded]'])
    expect(JSON.parse(persisted)).toMatchObject({
      message: '[message suppressed: input limit exceeded]',
      truncated: true,
    })
    expect(persisted).not.toMatch(/input-start|secret-at-input-tail/iu)
    expect(statSync(log.currentPath()).size).toBeLessThanOrEqual(256)
  })

  it.each([
    ['timestamp', 't'.repeat(129), 'loading-runtime'],
    ['type', '2026-08-24T08:00:00.000Z', 't'.repeat(129)],
  ] as const)('rejects an over-limit %s before reading the message', (_field, timestamp, type) => {
    const directory = makeLogDirectory()
    const log = new DesktopLog({ directory, maxBytes: 256, sensitiveValues: [], ...INPUT_LIMITS })
    let messageReads = 0
    const event = {
      timestamp,
      type,
      get message(): string {
        messageReads += 1
        return 'must not be processed'
      },
    }

    expect(() => log.append(event)).toThrow('metadata exceeds configured input limit')
    expect(messageReads).toBe(0)
  })
})
