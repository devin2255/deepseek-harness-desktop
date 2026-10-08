/** Real Loader, terminal backend, and tools with controlled OS observation loss. */

import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessOutcome, SubprocessTerminalHandle } from '@deepseek-ai/dsh-subprocess'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('terminal-readiness requires a config path')
const uninstallFailLoud = installFailLoud('terminal-readiness')
const ctx = await boot('terminal-readiness', resolveConfigPath(configPath, undefined))
try {
  let observed = false
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
    terminate: () => {
      closed = true
      output.end()
      outcome.resolve({ exitCode: 0, signal: null })
      return Promise.resolve()
    },
  }
  // Only the OS terminal transport is controlled; readiness and tool rendering stay real.
  ctx.subprocess.spawnTerminal = () => {
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
  observed = true
  const known = await execute('terminal_send', { sessionId: 'pty-1', text: 'true' })
  assert.match(known, /wait: stdin_read/)
  const close = await execute('terminal_close', { sessionId: 'pty-1' })
  assert.equal(closed, true)
  assert.equal(ctx.terminals.list(handle.agent).length, 0)
  console.log(JSON.stringify({ opened, unknownForeground: unknown, observedForeground: known, close, closed }))
} finally {
  await ctx.fiber.dispose()
  uninstallFailLoud()
}
