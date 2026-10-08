/** Keyless cold and resident root-delivery transcript over real Git and the Loader. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../writer-integration.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/task-delivery-driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./task-delivery.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const processTimeoutMs = 60_000

it('excludes root execution through real commit, apply, and discard before releasing ownership', async () => {
  const result = await runLoaderSmoke({ label: 'root delivery transcript', tempDirPrefix: 'dsh-root-delivery-',
    binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath, processTimeoutMs })
  expect(result.stderr).toBe('')
  expect(result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as object)).toEqual(
    ['cold', 'resident'].map(stage => ({ stage, blocked: ['commit', 'apply', 'discard'], receipts: ['commit', 'apply', 'discard'],
      branchRetained: true, sourceHeadPreserved: true, sourceContentApplied: true, reservationReleased: true })),
  )
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, result.stdout)
  expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
}, processTimeoutMs + 15_000)
