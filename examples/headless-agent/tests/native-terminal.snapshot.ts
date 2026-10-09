/** Keyless real-process terminal lifecycle through the runnable example Loader. */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('./fixtures/native-terminal/cordis.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/native-terminal/driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./native-terminal.expected.jsonl', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

it('retains native terminal input and joins its root, descendants, and output', async () => {
  const result = await runLoaderSmoke({ label: 'native terminal transcript', tempDirPrefix: 'dsh-native-terminal-',
    binScript, libBinScript: binScript, configPath, binArgs: [configPath], tsconfigPath })
  expect(result.stderr).toBe('')
  if (process.env.DSH_SNAPSHOT === 'refresh') await writeFile(expectedPath, result.stdout)
  expect(result.stdout).toBe(await readFile(expectedPath, 'utf8'))
}, 45_000)
