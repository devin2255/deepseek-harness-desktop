import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

import { REPOSITORY_ROOT } from './packaging-layout.ts'

const execFileAsync = promisify(execFile)
const enabled = process.platform === 'win32' && process.env.DSH_INSTALLER_E2E === '1'

describe.skipIf(!enabled)('native NSIS environment register preservation', () => {
  it.each([
    ['SemVer result', 'Pop $2', '${if} $1 != "0"', '0'],
    ['shortcut ownership', 'Pop $1', '${if} $0 == "0"', 'ignored-output'],
  ])('preserves the saved %s while clearing command environment', async (name, start, end, expected) => {
    const source = await readFile(join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh'), 'utf8')
    const owner = name === 'SemVer result' ? 'customInit' : 'DshRemoveOwnedShortcut'
    const body = source.split(`!macro ${owner}`)[1]!.split('!macroend')[0]!
    const commands = body.slice(body.indexOf(start) + start.length, body.indexOf(end))
      .replace(/!insertmacro DshE2eTrace[^\n]*/gu, '')
    await expect(runNativeRegisters(commands, expected)).resolves.toBe(expected)
  })

  it('preserves the close polling counter across process-query environment changes', async () => {
    const source = await readFile(join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh'), 'utf8')
    const body = source.split('!macro DshQueryInstalledProcess Target ExitCode Status')[1]!.split('!macroend')[0]!
    const commands = body
      .replace(/nsExec::ExecToStack[^\n]*\n\s*Pop[^\n]*\n\s*Pop[^\n]*/u, '')
      .replace(/!insertmacro DshE2eTrace[^\n]*/u, '')
      .replaceAll('${Target}', 'C:\\missing-dsh-register-probe.exe')
    await expect(runNativeRegisters(commands, '7')).resolves.toBe('7')
  })

  it.each([
    ['absent', 'valid', 'launched'], ['absent', 'invalid', 'blocked'],
    ['present', 'valid', 'launched'], ['present', 'invalid', 'blocked'],
  ])('reports only Exec errors with %s E2E metadata and a %s executable', async (mode, executable, expected) => {
    const source = await readFile(join(REPOSITORY_ROOT, 'apps/desktop/build/installer.nsh'), 'utf8')
    const body = source.split('!macro customCheckAppRunning')[1]!.split('!macroend')[0]!
    const start = body.indexOf('ClearErrors', body.indexOf('DshRequestClose:'))
    const end = body.indexOf('DshAfterCloseRequest:', start)
    const replacement = executable === 'valid' ? 'Exec \'"$EXEPATH" /DSH_CHILD\'' : 'Exec \'"$EXEPATH.missing"\''
    const launch = body.slice(start, end).replace(/Exec '[^\n]*'/gu, replacement)
    const commands = `System::Call 'kernel32::SetEnvironmentVariableW(w "DSH_INSTALLER_E2E", ${mode === 'present' ? 'w "1"' : 'p 0'}) i.r9'
${launch}
StrCpy $1 "launched"
Goto DshCloseDone
DshCloseBlocked:
StrCpy $1 "blocked"
DshCloseDone:`
    await expect(runNativeRegisters(commands, '0')).resolves.toBe(expected)
  })
})

async function runNativeRegisters(commands: string, initial: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nsis-registers-'))
  const script = join(root, 'probe.nsi')
  const executable = join(root, 'probe.exe')
  const result = join(root, 'result.txt')
  const cache = join(process.env.LOCALAPPDATA!, 'electron-builder/Cache/nsis-3.0.4.1')
  const compilers = (await readdir(cache, { recursive: true })).filter(path => /[\\/]Bin[\\/]makensis\.exe$/u.test(path))
  expect(compilers).toHaveLength(1)
  const compiler = join(cache, compilers[0]!)
  try {
    await writeFile(script, `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\n!include "LogicLib.nsh"\n!include "FileFunc.nsh"\nVar DshCloseE2eMode\nVar DshCloseE2eRoot\nVar DshCloseE2eOwnership\nOutFile "${executable}"\nSection\n\${GetParameters} $0\nStrCmp $0 "/DSH_CHILD" 0 +2\nQuit\nStrCpy $1 "${initial}"\n${commands}\nFileOpen $9 "${result}" w\nFileWrite $9 "$1"\nFileClose $9\nSectionEnd\n`)
    await execFileAsync(compiler, ['/V2', script], { timeout: 15_000 })
    await execFileAsync(executable, [], { timeout: 10_000 })
    return await readFile(result, 'utf8')
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}
