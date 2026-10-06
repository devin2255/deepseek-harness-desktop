/** Assembled local-provider transcript for committed Task worktree reuse. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../worktree-inspection.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/worktree-inspection-driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./worktree-inspection.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('reuses committed worktrees while rejecting a detached or unrelated checkout', async () => {
  const result = await runLoaderSmoke({
    label: 'committed worktree inspection transcript', tempDirPrefix: 'dsh-worktree-inspection-',
    binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath,
  })
  expect(result.stderr).toBe('')
  const rows = result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(rows).toEqual([
    { stage: 'created', availability: 'available' },
    { stage: 'committed', availability: 'available', commitAdvanced: true, baseRetained: true, sourceUnchanged: true },
    { stage: 'detached', availability: 'diverged' },
    { stage: 'unrelated-history', branchRetained: true, availability: 'diverged' },
  ])
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, result.stdout)
  expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
