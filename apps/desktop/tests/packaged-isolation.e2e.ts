import { createHash } from 'node:crypto'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  assertNoProductCollision,
  cleanupInstallerFixture,
  createInstallerFixture,
  exists,
  verifyInstalledApplication,
  type InstallerFixture,
} from './installer-support.ts'

const executable = process.env.DSH_DESKTOP_PACKAGED_PROBE_EXE
const enabled = process.platform === 'win32' && process.arch === 'x64' && executable !== undefined

interface FileProbe {
  readonly exists: boolean
  readonly bytes?: number
  readonly modifiedMs?: number
  readonly sha256?: string
}

describe.skipIf(!enabled)('packaged desktop data isolation probe', () => {
  let fixture: InstallerFixture
  let realLogBefore: FileProbe
  const realLog = join(process.env.APPDATA ?? '', 'DeepSeek Harness', 'logs', 'desktop.log')

  beforeAll(async () => {
    fixture = await createInstallerFixture(await mkdtemp(join(tmpdir(), 'dsh-installer-e2e-')))
    await assertNoProductCollision(fixture)
    realLogBefore = await fileProbe(realLog)
  })

  afterAll(async () => {
    if (fixture !== undefined) await cleanupInstallerFixture(fixture)
  })

  it('keeps logs, Harness home, and the Electron profile inside the owned fixture', async () => {
    await verifyInstalledApplication(fixture, dirname(executable as string))

    await expect(exists(join(fixture.productData, 'logs', 'desktop.log'))).resolves.toBe(true)
    await expect(exists(join(fixture.productData, 'Harness'))).resolves.toBe(true)
    await expect(exists(join(fixture.appData, '@deepseek-ai', 'dsh-desktop', 'Local State'))).resolves.toBe(true)
    expect(await fileProbe(realLog)).toEqual(realLogBefore)
  })
})

async function fileProbe(path: string): Promise<FileProbe> {
  try {
    const [status, contents] = await Promise.all([stat(path), readFile(path)])
    return {
      exists: true,
      bytes: status.size,
      modifiedMs: status.mtimeMs,
      sha256: createHash('sha256').update(contents).digest('hex'),
    }
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { exists: false }
    throw error
  }
}
