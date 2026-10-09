/** Real Loader, terminal backend, and tools with controlled OS observation loss. */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

const configPath = process.argv[2]
const powershell = process.argv[3] === 'powershell'
if (configPath === undefined) throw new Error('terminal-readiness requires a config path')
const uninstallFailLoud = installFailLoud('terminal-readiness')
const ctx = await boot('terminal-readiness', resolveConfigPath(configPath, undefined))
try {
  let observed = false
  let interrupted = 0
  let closed = false
  const output = new PassThrough()
  const outcome = Promise.withResolvers<SubprocessOutcome>()
  const prompt = '\x1b]133;D;0\x07dsh> '
  const terminal: SubprocessTerminalHandle = {
    pid: 123,
    output,
    done: outcome.promise,
    write: () => { setImmediate(() => { output.write(prompt) }); return Promise.resolve() },
    inspectForeground: () => Promise.resolve(observed ? { processGroupId: 123, inputWaiting: false } : undefined),
    signalForeground: () => Promise.reject(new Error('No foreground group to signal')),
    interrupt: () => {
      if (!powershell) return Promise.reject(new Error('No foreground group to interrupt'))
      interrupted += 1
      setImmediate(() => { output.write(prompt) })
      return Promise.resolve({ kind: 'control-input', input: 'ctrl-c' })
    },
    terminate: () => {
      closed = true
      output.end()
      outcome.resolve({ exitCode: 0, signal: null })
      return Promise.resolve()
    },
  }
  // Only the OS terminal transport is controlled; readiness and tool rendering stay real.
  if (powershell) ctx.subprocess.resolveExecutable = (command) => {
    assert.equal(command, 'powershell.exe')
    return Promise.resolve('fixture-powershell')
  }
  ctx.subprocess.spawnTerminal = (spec) => {
    if (powershell) {
      assert.equal(spec.argv[0], 'fixture-powershell')
      assert.deepEqual(spec.argv.slice(1, 5), ['-NoLogo', '-NoProfile', '-NoExit', '-EncodedCommand'])
      assert.match(Buffer.from(spec.argv[5]!, 'base64').toString('utf16le'), /function global:prompt/)
      assert.equal(spec.env?.PROMPT_COMMAND, undefined)
    }
    setImmediate(() => { output.write(prompt) })
    return Promise.resolve(terminal)
  }
  const handle = await ctx.agents.create({ sessionId: SessionId('terminal-readiness'),
    agentOptions: { provider: 'fixture', model: 'fixture' } })
  const execute = async (name: string, args: Record<string, unknown>) => {
    const result = await ctx.tools.execute({ name, arguments: args, agent: handle.agent,
      callId: CallId(name), signal: new AbortController().signal })
    return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  }
  const opened = await execute('terminal_open', { type: 'shell', name: 'main' })
  assert.equal(ctx.terminals.list(handle.agent).length, 1)
  const unknown = await execute('terminal_send', { sessionId: 'pty-1', text: 'true' })
  assert.match(unknown, /wait: inferred_idle/)
  observed = !powershell
  if (powershell) {
    const operation = ctx.terminals.startSend(handle.agent, ctx.terminals.list(handle.agent)[0]!.sessionId,
      { text: 'Start-Sleep 60', submit: true })
    assert.equal(operation.cancel(), true)
    assert.equal(operation.cancel(), false)
    assert.equal((await operation.done).waitReason, 'inferred_idle')
    assert.equal(interrupted, 1)
  }
  const known = await execute('terminal_send', { sessionId: 'pty-1', text: 'true' })
  assert.match(known, powershell ? /wait: inferred_idle/ : /wait: stdin_read/)
  const close = await execute('terminal_close', { sessionId: 'pty-1' })
  assert.equal(closed, true)
  assert.equal(ctx.terminals.list(handle.agent).length, 0)
  console.log(JSON.stringify({ opened, unknownForeground: unknown, observedForeground: known,
    ...powershell ? { nativeInterrupts: interrupted } : {}, close, closed }))
} finally {
  await ctx.fiber.dispose()
  uninstallFailLoud()
}
