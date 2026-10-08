/** Keyless assembled terminal output for missing and restored foreground facts. */

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('./fixtures/terminal-readiness/cordis.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/terminal-readiness/driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./terminal-readiness.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('reports inferred idle until the terminal provider observes a foreground group', async () => {
  const result = await runLoaderSmoke({ label: 'terminal readiness transcript', tempDirPrefix: 'dsh-terminal-readiness-',
    binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath })
  expect(result.stderr).toBe('')
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, result.stdout)
  expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
}, 45_000)
