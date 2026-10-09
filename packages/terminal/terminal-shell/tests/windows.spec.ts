/** Native PowerShell state, interruption, confinement, and owned process cleanup. */

import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TerminalSessionService, { type TerminalSendOperation } from '@deepseek-ai/dsh-terminal'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSandbox from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as TerminalShell from '@deepseek-ai/dsh-terminal-shell'
import { describe, expect, it, vi } from 'vitest'

const quote = (text: string): string => "'" + text.replaceAll("'", "''") + "'"

async function harness(shellPath: string, mode: 'danger-full-access' | 'workspace-write' | 'read-only') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-powershell-中文 space-'))
  const ctx = new Context()
  try {
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TerminalSessionService)
    await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: root })
    await ctx.plugin(LocalSubprocessRuntime)
    if (mode !== 'danger-full-access') await ctx.plugin(LocalSandbox)
    await ctx.plugin(TerminalShell, { shell: 'powershell', shellPath,
      pollIntervalMs: 20, idleSilenceMs: 1000, handoffGraceMs: 100, timeoutMs: 10_000, disposeGraceMs: 5000 })
    const scope = ctx.plugin(() => {})
    const id = SessionId('powershell-native')
    const session = Session.create(id, undefined, { version: 0, id, createdAt: 0, cwd: root })
    const owner: Agent = { id, session, options: {}, ctx: scope.ctx, status: 'idle',
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
      runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve() }
    ctx.agents.register(owner)
    return { ctx, root, owner, scope, async dispose() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) } }
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function waitForOutput(operation: TerminalSendOperation, pattern: RegExp): Promise<string> {
  let output = ''
  await vi.waitFor(() => {
    output += operation.readOutput().delta
    expect(output).toMatch(pattern)
  }, { timeout: 10_000, interval: 20 })
  return output
}

describe.skipIf(process.platform !== 'win32')('persistent native PowerShell backend', () => {
  it.each(['powershell.exe', 'pwsh'])('retains Unicode, cwd, functions and state after interrupt in %s', { timeout: 45_000 }, async (shellPath) => {
    const fixture = await harness(shellPath, 'danger-full-access')
    const { ctx, owner, root } = fixture
    try {
      const opened = await ctx.terminals.spawn(owner, { type: 'shell', cwd: root })
      expect(opened.motd).toContain('dsh>')
      const send = (text: string) => ctx.terminals.startSend(owner, opened.sessionId, { text, submit: true })
      const nested = join(root, 'nested space')
      await mkdir(nested)
      await send("$global:keep = 'persistent 中文'; function global:Get-TestState { $global:keep }; Set-Location -LiteralPath " + quote(nested)).done
      await send("if ($true) {\r\n$global:multi = '多行'\r\n}\r\n").done
      const result = await send("Write-Output ('__STATE'+'__'+(Get-TestState)); Write-Output ('__CWD'+'__'+(Get-Location).Path)").done
      expect(result.waitReason).toBe('inferred_idle')
      expect(result.viewport).toContain('__STATE__persistent 中文')
      expect(result.viewport).toContain(`__CWD__${await realpath(nested)}`)
      expect((await send("Write-Output ('__MULTI'+'__'+$global:multi)").done).viewport).toContain('__MULTI__多行')
      const child = send('& ' + quote(process.execPath) + ' -e ' + quote("console.log('__CHILD__'+process.pid+'__');setInterval(()=>{},1000)"))
      const output = await waitForOutput(child, /__CHILD__(\d+)__/u)
      const childPid = Number(/__CHILD__(\d+)__/u.exec(output)?.[1])
      expect(child.cancel()).toBe(true)
      expect(child.cancel()).toBe(false)
      const interrupted = await child.done
      expect(interrupted.waitReason).toBe('inferred_idle')
      expect(interrupted.viewport).toContain('dsh>')
      expect(() => process.kill(childPid, 0)).toThrow()
      expect((await send("Write-Output ('__AFTER'+'__'+(Get-TestState))").done).viewport)
        .toContain('__AFTER__persistent 中文')
      const interactive = send('& ' + quote(process.execPath) + ' -e ' + quote("console.log('__WAIT__');require('node:readline').createInterface({input:process.stdin}).once('line',line=>{console.log('__INPUT__'+line);process.exit(0)})"))
      expect((await interactive.done).waitReason).toBe('inferred_idle')
      expect((await send('中文 input').done).viewport).toContain('__INPUT__中文 input')
      await ctx.terminals.kill(owner, opened.sessionId)
      expect(() => process.kill(opened.pid!, 0)).toThrow()
      expect(ctx.terminals.list(owner)).toEqual([])
    } finally {
      await fixture.dispose()
    }
  })

  it.each([
    { shellPath: 'powershell.exe', mode: 'workspace-write' },
    { shellPath: 'powershell.exe', mode: 'read-only' },
    { shellPath: 'pwsh', mode: 'workspace-write' },
    { shellPath: 'pwsh', mode: 'read-only' },
  ] as const)('runs $shellPath under real $mode confinement without an unrestricted fallback', { timeout: 45_000 }, async ({ shellPath, mode }) => {
    const fixture = await harness(shellPath, mode)
    const { ctx, root, owner } = fixture
    const outside = await mkdtemp(join(tmpdir(), 'dsh-powershell-outside-'))
    try {
      const opened = await ctx.terminals.spawn(owner, { type: 'shell' })
      expect(opened.motd).toContain('dsh>')
      expect(opened.motd).not.toContain('CategoryInfo')
      const path = join(root, 'result.txt')
      const operation = ctx.terminals.startSend(owner, opened.sessionId, {
        text: `try { Set-Content -LiteralPath ${quote(path)} -Value 'written' -NoNewline -Encoding UTF8 -ErrorAction Stop; Write-Output ('__WRITE'+'__ok') } catch { Write-Output ('__DENIED'+'__') }`,
        submit: true,
      })
      const result = await operation.done
      expect(result.waitReason).toBe('inferred_idle')
      if (mode === 'workspace-write') {
        expect(result.viewport).toContain('__WRITE__ok')
        expect((await readFile(path, 'utf8')).replace(/^\uFEFF/u, '')).toBe('written')
      } else {
        expect(result.viewport).toContain('__DENIED__')
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
      const outsidePath = join(outside, 'must-not-exist.txt')
      const denied = ctx.terminals.startSend(owner, opened.sessionId, {
        text: `try { Set-Content -LiteralPath ${quote(outsidePath)} -Value 'escaped' -ErrorAction Stop; Write-Output ('__ESCAPED'+'__') } catch { Write-Output ('__OUTSIDE'+'__denied') }`,
        submit: true,
      })
      expect((await denied.done).viewport).toContain('__OUTSIDE__denied')
      await expect(readFile(outsidePath)).rejects.toMatchObject({ code: 'ENOENT' })
      const child = ctx.terminals.startSend(owner, opened.sessionId, {
        text: '& ' + quote(process.execPath) + ' -e ' + quote("console.log('__CONFINED__'+process.pid+'__');setInterval(()=>{},1000)"), submit: true,
      })
      const output = await waitForOutput(child, /__CONFINED__(\d+)__/u)
      const childPid = Number(/__CONFINED__(\d+)__/u.exec(output)?.[1])
      expect(child.cancel()).toBe(true)
      const interrupted = await child.done
      expect(interrupted.waitReason).toBe('inferred_idle')
      expect(interrupted.viewport).toContain('dsh>')
      expect(() => process.kill(childPid, 0)).toThrow()
      const after = ctx.terminals.startSend(owner, opened.sessionId, { text: "Write-Output ('__RESUMED'+'__')", submit: true })
      expect((await after.done).viewport).toContain('__RESUMED__')
      await ctx.terminals.kill(owner, opened.sessionId)
      expect(() => process.kill(opened.pid!, 0)).toThrow()
    } finally {
      await fixture.dispose()
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('awaits owner disposal with a running native descendant', { timeout: 20_000 }, async () => {
    const fixture = await harness('powershell.exe', 'workspace-write')
    const { ctx, owner, scope } = fixture
    try {
      const opened = await ctx.terminals.spawn(owner, { type: 'shell' })
      const operation = ctx.terminals.startSend(owner, opened.sessionId, {
        text: '& ' + quote(process.execPath) + ' -e ' + quote("console.log('__OWNED__'+process.pid+'__');setInterval(()=>{},1000)"), submit: true,
      })
      const output = await waitForOutput(operation, /__OWNED__(\d+)__/u)
      const childPid = Number(/__OWNED__(\d+)__/u.exec(output)?.[1])
      await scope.dispose()
      expect((await operation.done).waitReason).toBe('session_exit')
      expect(() => process.kill(opened.pid!, 0)).toThrow()
      expect(() => process.kill(childPid, 0)).toThrow()
      expect(ctx.terminals.list(owner)).toEqual([])
    } finally {
      await fixture.dispose()
    }
  })
})
