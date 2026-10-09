/** Native Windows acceptance for persistent PowerShell and exact Job teardown. */

import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LocalSubprocessRuntime from '../src/index.ts'
import { createWindowsPty, windowsTerminalCommand, windowsTerminalEnvironment } from '../src/windows-pty.ts'

describe('Windows terminal encoding', () => {
  it('quotes empty, spaced, quoted, and trailing-backslash argv without shell interpretation', () => {
    expect(windowsTerminalCommand(['program', '', 'two words', 'a"b', 'space \\']).toString('utf16le'))
      .toBe('program "" "two words" "a\\"b" "space \\\\"\0')
    expect(() => windowsTerminalCommand(['bad\0argument'])).toThrow('NUL')
  })

  it.skipIf(process.platform !== 'win32')('encodes an explicit environment in native ordinal order', () => {
    expect(windowsTerminalEnvironment({ z: '中文', A: 'space value', omitted: undefined }).toString('utf16le'))
      .toBe('A=space value\0z=中文\0\0')
    expect(windowsTerminalEnvironment({ ä: 'accent', _: 'under', A: 'letter', 0: 'number' }).toString('utf16le'))
      .toBe('0=number\0A=letter\0_=under\0ä=accent\0\0')
  })

  it('encodes an empty environment and rejects invalid native strings', () => {
    expect(windowsTerminalEnvironment({}).toString('utf16le')).toBe('\0\0')
    for (const environment of [{ '': 'value' }, { 'a=b': 'c' }, { 'a\0': 'c' }, { a: 'b\0' }]) {
      expect(() => windowsTerminalEnvironment(environment)).toThrow('invalid name or NUL')
    }
  })
})

describe.skipIf(process.platform !== 'win32')('Windows native terminal', () => {
  const shell = join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')

  it.each([
    { label: 'Windows PowerShell 5.1', command: shell, major: 5 },
    { label: 'PowerShell 7', command: 'pwsh', major: 7 },
  ])('interrupts a real foreground child and retains $label state', { timeout: 30_000 }, async ({ command, major }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-interrupt-中文 space-'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const quote = (text: string): string => "'" + text.replaceAll("'", "''") + "'"
    let output = ''
    try {
      const executable = await ctx.subprocess.resolveExecutable(command)
      const handle = await ctx.subprocess.spawnTerminal({
        argv: [executable, '-NoLogo', '-NoProfile', '-NoExit', '-Command',
          "Remove-Module PSReadLine -ErrorAction SilentlyContinue; $global:keep = 'persistent 中文'; function global:Get-TestState { $global:keep }; function global:prompt { '__READY__> ' }"],
        cwd, rows: 40, cols: 240, graceMs: 5000,
      })
      handle.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
      await vi.waitFor(() => { expect(output).toContain('__READY__> ') }, { timeout: 10_000 })
      await handle.write("Write-Output ('__VERSION'+'__'+$PSVersionTable.PSVersion.Major)\r")
      await vi.waitFor(() => { expect(output).toContain(`__VERSION__${major}`) }, { timeout: 5000 })
      const childCode = "console.log('__CHILD__'+process.pid+'__');setInterval(()=>{},1000)"
      await handle.write('& ' + quote(process.execPath) + ' -e ' + quote(childCode) + '\r')
      await vi.waitFor(() => { expect(output).toMatch(/__CHILD__(\d+)__/u) }, { timeout: 5000 })
      const child = Number(/__CHILD__(\d+)__/u.exec(output)?.[1])
      expect(() => process.kill(child, 0)).not.toThrow()
      const beforeInterrupt = output.length
      await expect(handle.interrupt()).resolves.toEqual({ kind: 'control-input', input: 'ctrl-c' })
      await vi.waitFor(() => { expect(() => process.kill(child, 0)).toThrow() }, { timeout: 5000 })
      expect(() => process.kill(handle.pid, 0)).not.toThrow()
      // Child exit precedes the shell's input-buffer reset and new prompt.
      await vi.waitFor(() => { expect(output.slice(beforeInterrupt)).toContain('__READY__> ') }, { timeout: 5000 })
      await handle.write("Write-Output ('__KEEP'+'__'+$global:keep); Write-Output ('__FUNCTION'+'__'+(Get-TestState))\r")
      await vi.waitFor(() => { expect(output).toContain('__FUNCTION__persistent 中文') }, { timeout: 5000 })
      expect(output).toContain('__KEEP__persistent 中文')
      await handle.terminate()
      expect(() => process.kill(handle.pid, 0)).toThrow()
      expect(handle.output.readableEnded).toBe(true)
    } finally {
      await fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('preserves PowerShell state and closes a real foreground descendant', { timeout: 30_000 }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-终端 space-'))
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const quote = (text: string): string => "'" + text.replaceAll("'", "''") + "'"
    let output = ''
    try {
      const handle = await ctx.subprocess.spawnTerminal({ argv: [shell, '-NoLogo', '-NoProfile', '-NoExit', '-Command',
        "Remove-Module PSReadLine -ErrorAction SilentlyContinue; function global:prompt { '__READY__> ' }"],
      cwd, rows: 40, cols: 240, graceMs: 5000 })
      handle.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
      await vi.waitFor(() => { expect(output).toContain('__READY__> ') }, { timeout: 10_000 })
      await expect(handle.inspectForeground()).resolves.toBeUndefined()
      await expect(handle.signalForeground('SIGINT')).rejects.toThrow('does not support POSIX')
      await handle.write("$env:DSH_TEST_STATE = 'persistent 中文'; function global:Get-TestState { $env:DSH_TEST_STATE }; Write-Output ('__SET'+'__')\r")
      await vi.waitFor(() => { expect(output).toContain('\n__SET__') }, { timeout: 5000 })
      await handle.write("Write-Output ('__VALUE__' + (Get-TestState)); Write-Output ('__CWD__' + (Get-Location).Path)\r")
      await vi.waitFor(() => { expect(output).toContain('__VALUE__persistent 中文') }, { timeout: 5000 })
      // Windows temp paths may use 8.3 aliases while PowerShell prints long names.
      const canonicalCwd = await realpath(cwd)
      await vi.waitFor(() => { expect(output).toContain(`__CWD__${canonicalCwd}`) }, { timeout: 5000 })
      const childCode = "console.log('__CHILD__'+process.pid+'__');setInterval(()=>{},1000)"
      await handle.write(`& ${quote(process.execPath)} -e ${quote(childCode)}\r`)
      await vi.waitFor(() => { expect(output).toMatch(/__CHILD__(\d+)__/u) }, { timeout: 5000 })
      const child = Number(/__CHILD__(\d+)__/u.exec(output)?.[1])
      expect(() => process.kill(child, 0)).not.toThrow()
      await handle.terminate()
      await expect(handle.done).resolves.toEqual({ exitCode: 1, signal: null })
      expect(() => process.kill(handle.pid, 0)).toThrow()
      expect(() => process.kill(child, 0)).toThrow()
      expect(handle.output.readableEnded).toBe(true)
      await expect(handle.write('must not run')).rejects.toThrow('closing')
      await handle.terminate()
    } finally {
      await fiber.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('rejects invalid allocation before running a child and preserves cancellation reasons', async () => {
    const base = { argv: [shell], cwd: process.cwd(), cols: 80, rows: 24, graceMs: 1000 }
    for (const dimension of [0, -1, 32768, 0.5, NaN]) {
      await expect(createWindowsPty({ ...base, cols: dimension }, {})).rejects.toThrow('dimensions')
    }
    for (const graceMs of [0, -1, Infinity, 2147483648]) {
      await expect(createWindowsPty({ ...base, graceMs }, {})).rejects.toThrow('graceMs')
    }
    const reason = new Error('allocation canceled')
    await expect(createWindowsPty({ ...base, signal: AbortSignal.abort(reason) }, {})).rejects.toBe(reason)
    await expect(createWindowsPty({ ...base, argv: ['Z:/missing-terminal-program.exe'] }, {})).rejects.toThrow('CreateProcessW')
  })

  it('joins in-flight allocation before provider disposal finishes', { timeout: 15_000 }, async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LocalSubprocessRuntime)
    const service = ctx.subprocess
    const allocated = service.spawnTerminal({ argv: [shell], cwd: process.cwd(), cols: 80, rows: 24, graceMs: 5000 })
    const rejected = expect(allocated).rejects.toThrow('disposing')
    await fiber.dispose()
    await rejected
    await expect(service.spawnTerminal({ argv: [shell], cwd: process.cwd(), cols: 80, rows: 24, graceMs: 5000 })).rejects.toThrow('disposing')
  })
})
