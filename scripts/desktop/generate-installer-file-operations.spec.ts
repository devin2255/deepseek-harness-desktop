import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readInstallerFileOperationsTemplate,
  renderInstallerFileOperations,
  verifyInstallerFileOperations,
} from './generate-installer-file-operations.ts'
import { REPOSITORY_ROOT } from './packaging-layout.ts'

const template = await readInstallerFileOperationsTemplate()

describe('generated installer file operations', () => {
  it('verifies under the declared Node source launcher without dependency hoisting', async () => {
    const script = 'import { verifyInstallerFileOperations } from "./scripts/desktop/generate-installer-file-operations.ts";'
      + ' await verifyInstallerFileOperations();'
    await expect(promisify(execFile)('node', ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
      cwd: REPOSITORY_ROOT,
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      timeout: 15_000,
      windowsHide: true,
    })).resolves.toMatchObject({ stdout: '' })
  })
  it('rejects unreviewed upstream changes and accepts checkout line endings', () => {
    expect(() => renderInstallerFileOperations(template.replace('Rename', 'Delete'))).toThrow(/review changed/u)
    expect(renderInstallerFileOperations(template.replace(/\r?\n/gu, '\r\n'))).toBe(renderInstallerFileOperations(template))
  })

  it('includes the fresh generated operations in the installer and its build gate', async () => {
    const installer = await readFile(join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh'), 'utf8')
    const build = await readFile(join(REPOSITORY_ROOT, 'scripts/desktop/build-installer.ts'), 'utf8')
    expect(installer).toContain('!include "${BUILD_RESOURCES_DIR}\\uninstall-files.nsh"')
    expect(build).toContain('await verifyInstallerFileOperations()')
    await verifyInstallerFileOperations()
  })
})
