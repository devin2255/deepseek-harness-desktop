/** Shared Task wire fixtures exercise SDK decoding through a real protocol peer. */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekHarness, SdkProtocolError, type TaskIntegrationNode, type TaskSnapshot } from '../src/index.ts'

const fixture = fileURLToPath(new URL('../../../../scripts/snapshots/task-integration-sdk/task.json', import.meta.url))
const invalid = JSON.parse(readFileSync(new URL('../../../../scripts/snapshots/task-integration-sdk/invalid.json', import.meta.url), 'utf8')) as {
  name: string
  path: string
  value: unknown
}[]
const row = JSON.parse(readFileSync(fixture, 'utf8')) as TaskSnapshot
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

function harness(path: string): DeepSeekHarness {
  const value = new DeepSeekHarness({ launch: {
    command: process.execPath,
    args: [fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))],
    env: { ...process.env as Record<string, string>, FAKE_TASK_INTEGRATION: path },
  } })
  cleanups.push(() => value.close())
  return value
}

describe('SDK integration history', () => {
  it('preserves every outcome, historical resolution, and unknown publication state', async () => {
    expect((await harness(fixture).listTasks()).tasks[0]).toEqual(row)
  })

  it.each(['complete', 'partial', 'earlier-second-writer', 'later-republication'] as const)('validates %s contributor coverage across separate batches', async (mode) => {
    const original = row.integrations![0]!
    const integrated = row.integrations![4]!
    if (original.outcome.kind !== 'conflict' || integrated.outcome.kind !== 'integrated') throw new Error('Fixture outcomes changed')
    const [a, b] = row.descendantSessionIds
    if (a === undefined || b === undefined) throw new Error('Fixture writers are missing')
    const receipt = integrated.outcome.result
    const template = receipt.contributors[0]!
    const publication = (callSeq: number, id: typeof a): TaskIntegrationNode => ({
      id: `${row.taskId}:integration:${callSeq}` as TaskIntegrationNode['id'], callSeq, startedAt: callSeq,
      writerSessionIds: [id], outcome: { kind: 'integrated', result: {
        ...receipt, contributors: [{ ...template, sessionId: id }], integratedAt: callSeq + 1,
      } },
    })
    const conflict = {
      ...original, writerSessionIds: [a, b], outcome: { kind: 'conflict', result: {
        ...original.outcome.result, contributors: [a, b].map(sessionId => ({ ...template, sessionId })),
      } },
    } satisfies TaskIntegrationNode
    if (mode === 'partial') delete conflict.resolvedBy
    else conflict.resolvedBy = `${row.taskId}:integration:${mode === 'later-republication' ? 9 : 8}` as TaskIntegrationNode['id']
    const first = mode === 'earlier-second-writer' ? b : a
    const second = mode === 'earlier-second-writer' ? a : b
    const integrations = [conflict, publication(5, first), ...mode === 'partial' ? [] : [publication(8, second)], publication(9, a)]
    const modified = { ...row, asOfSeq: 10, integrations }
    const dir = await mkdtemp(join(tmpdir(), 'dsh-integration-coverage-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'task.json')
    await writeFile(file, JSON.stringify(modified))
    if (mode === 'later-republication') await expect(harness(file).listTasks()).rejects.toThrow(SdkProtocolError)
    else expect((await harness(file).listTasks()).tasks[0]).toEqual(JSON.parse(JSON.stringify(modified)))
  })

  it.each(invalid)('rejects $name as a protocol error', async ({ path, value }) => {
    const modified = structuredClone(row) as unknown as Record<string, unknown>
    const keys = path.split('/')
    let target = modified
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>
    target[keys.at(-1)!] = value
    const dir = await mkdtemp(join(tmpdir(), 'dsh-integration-wire-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    const file = join(dir, 'task.json')
    await writeFile(file, JSON.stringify(modified))
    await expect(harness(file).listTasks()).rejects.toThrow(SdkProtocolError)
  })
})
