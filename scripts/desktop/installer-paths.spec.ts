import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { readInstallerFileOperationsTemplate, renderInstallerFileOperations } from './generate-installer-file-operations.ts'

const execFileAsync = promisify(execFile)
const enabled = process.platform === 'win32' && process.env.DSH_INSTALLER_E2E === '1'

describe.skipIf(!enabled)('native NSIS update file relocation', () => {
  it.each(['update', 'rollback', 'uninstall'])('handles long runtime paths during %s', async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-nsis-paths-'))
    const install = join(root, 'install')
    const runtimePath = 'resources/app/node_modules/@deepseek-ai/dsh-session-telemetry-otel/node_modules/@opentelemetry/resources/build/esnext/detectors/platform/node/machine-id/getMachineId-unsupported.js.map'
    const relative = mode === 'uninstall'
      ? join('nested'.repeat(Math.max(1, Math.ceil((280 - join(install, runtimePath).length) / 6))), runtimePath)
      : runtimePath
    const baseStaging = join(root, 'appdata', 'local', 'temp', 'nsis-update')
    const staging = join(baseStaging, 's'.repeat(Math.max(1, 280 - join(baseStaging, 'old-install', relative).length)))
    const source = join(install, relative)
    const destination = join(staging, 'old-install', relative)
    const template = await readInstallerFileOperationsTemplate()
    const operations = renderInstallerFileOperations(template).replaceAll('un.Dsh', 'Dsh')
    const script = join(root, 'probe.nsi')
    const executable = join(root, 'probe.exe')
    const cache = join(process.env.LOCALAPPDATA!, 'electron-builder/Cache/nsis-3.0.4.1')
    const compilers = (await readdir(cache, { recursive: true })).filter(path => /[\\/]Bin[\\/]makensis\.exe$/u.test(path))
    expect(compilers).toHaveLength(1)
    try {
      if (mode === 'uninstall') expect(source.length).toBeGreaterThan(260)
      expect(destination.length).toBeGreaterThan(260)
      await mkdir(dirname(source), { recursive: true })
      await mkdir(join(staging, 'old-install'), { recursive: true })
      await writeFile(source, 'runtime fixture')
      await writeFile(join(install, '000-before.txt'), 'earlier file')
      if (mode === 'rollback') await mkdir(destination, { recursive: true })
      await writeFile(script, `Unicode true
RequestExecutionLevel user
SilentInstall silent
!include "LogicLib.nsh"
!define UNINSTALL_FILENAME "uninstall.exe"
!define BUILD_UNINSTALLER
!macro _isUpdated _a _b _t _f
  Goto \`\${${mode === 'uninstall' ? '_f' : '_t'}}\`
!macroend
!define isUpdated '\"\" isUpdated \"\"'
!macro DshE2eTrace Message
!macroend
OutFile "${executable}"
Var ProbeStaging
${operations.replaceAll('$PLUGINSDIR', '$ProbeStaging')}
!insertmacro DshUninstallFileFunctions
Section
StrCpy $INSTDIR "${install}"
StrCpy $ProbeStaging "${staging}"
!insertmacro customRemoveFiles
SectionEnd
`)
      await execFileAsync(join(cache, compilers[0]!), ['/V2', script], { timeout: 15_000 })
      if (mode === 'rollback') {
        await expect(execFileAsync(executable, [], { timeout: 10_000 })).rejects.toMatchObject({ code: 2 })
        expect(await readFile(source, 'utf8')).toBe('runtime fixture')
        expect(await readFile(join(install, '000-before.txt'), 'utf8')).toBe('earlier file')
      } else {
        await execFileAsync(executable, [], { timeout: 10_000 })
        await expect(access(install)).rejects.toMatchObject({ code: 'ENOENT' })
        if (mode === 'update') expect(await readFile(destination, 'utf8')).toBe('runtime fixture')
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
