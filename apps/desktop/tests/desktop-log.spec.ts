import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopLog } from '../src/desktop-log.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeLogDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-desktop-log-'))
  temporaryDirectories.push(directory)
  return join(directory, 'owned', 'logs')
}

describe('DesktopLog', () => {
  it('creates the owned directory and appends one redacted JSON line per lifecycle event', () => {
    const directory = makeLogDirectory()
    const secret = 'sk-private-value'
    const log = new DesktopLog({ directory, maxBytes: 4_096, sensitiveValues: [secret] })

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
    const log = new DesktopLog({ directory, maxBytes: firstBytes + secondBytes, sensitiveValues: [] })

    log.append(first)
    log.append(second)

    expect(readFileSync(log.currentPath(), 'utf8')).toBe(`${JSON.stringify(second)}\n`)
  })

  it('rejects invalid rotation thresholds instead of supplying an implicit tuning default', () => {
    expect(() => new DesktopLog({ directory: makeLogDirectory(), maxBytes: 0, sensitiveValues: [] })).toThrow(
      'maxBytes must be a positive integer',
    )
  })
})
