/** Real assembled writer tools and immutable source-checkout evidence. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../writer-integration.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/writer-integration-driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./writer-integration.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
// Four real Git writers and two complete Host boots need more headroom than a single-boot smoke.
const processTimeoutMs = 60_000

it('reviews and commits writers, preserves a conflicting batch, and integrates a complete clean batch', async () => {
  const result = await runLoaderSmoke({ label: 'writer integration transcript', tempDirPrefix: 'dsh-writer-integration-',
    binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath, processTimeoutMs })
  expect(result.stderr).toBe('')
  expect(result.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as object)).toEqual([
    { stage: 'writer-review', activeRejected: true, childIdentity: true, diffPresent: true, noActivation: true },
    { stage: 'conflict', reported: true, paths: ['same.txt'], rootUnchanged: true },
    { stage: 'integrated', reported: true, contributors: 2, filesPresent: true, rootClean: true, sourceUnchanged: true },
    { stage: 'transcript', reviews: 4, commits: 4, integrations: 2, errors: 0 },
    { stage: 'projection', outcomes: ['conflict', 'integrated'], writers: [[0, 1], [2, 3]], conflictRetained: true, status: 'needs-attention' },
    { stage: 'next-wave', usesIntegratedBaseline: true },
    { stage: 'cold-replay', nodesUnchanged: true, conflictRetained: true, noAgentActivation: true },
  ])
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, result.stdout)
  expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
}, processTimeoutMs + 15_000)
