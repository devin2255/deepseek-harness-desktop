/** Assembled transcript of two active isolated writer Sessions. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../isolated-writer.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/isolated-writer-driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./isolated-writer.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('executes two isolated writers without modifying their integration or source checkout', async () => {
  const result = await runLoaderSmoke({
    label: 'isolated writer transcript', tempDirPrefix: 'dsh-isolated-writer-',
    binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath,
  })
  expect(result.stderr).toBe('')
  expect(result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as object)).toEqual([
    { stage: 'published', bothRunning: true, separateDirectories: true, sameBase: true, parentRecorded: true },
    { stage: 'written', stopReasons: ['completed', 'completed'], independentContents: true, rootUnchanged: true, sourceUnchanged: true },
    { stage: 'cold-inspection', assignmentRetained: true, cwdRetained: true, childGone: true },
  ])
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, result.stdout)
  expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
