/** Real Loader and native terminal process transcript, shared across supported hosts. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('native-terminal requires a config path')
const root = await mkdtemp(join(tmpdir(), 'dsh-native-terminal-中文 space-'))
const uninstall = installFailLoud('native-terminal')
const ctx = await boot('native-terminal', resolveConfigPath(configPath, undefined))
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error('native terminal observation timed out')
    await pause(15)
  }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
try {
  const state = join(root, 'tree.json')
  const child = fileURLToPath(new URL('./terminal-child.ts', import.meta.url))
  const terminal = await ctx.subprocess.spawnTerminal({ argv: [process.execPath, child, state],
    cwd: root, cols: 160, rows: 40, graceMs: 5000 })
  let output = ''
  terminal.output.on('data', (data: Buffer) => { output += data.toString('utf8') })
  await until(async () => {
    try { JSON.parse(await readFile(state, 'utf8')); return true } catch { return false }
  })
  const tree = JSON.parse(await readFile(state, 'utf8')) as { root: number; descendant: number }
  assert.equal(tree.root, terminal.pid)
  assert(alive(tree.descendant))
  await terminal.write('ping\r')
  await until(() => output.includes('__PONG__:1'))
  await terminal.write('ping\r')
  await until(() => output.includes('__PONG__:2'))
  const interrupt = await terminal.interrupt()
  if (process.platform === 'win32') {
    assert.deepEqual(interrupt, { kind: 'control-input', input: 'ctrl-c' })
  } else {
    assert.equal(interrupt.kind, 'signal')
    if (interrupt.kind === 'signal') {
      assert.equal(interrupt.signal, 'SIGINT')
      assert.equal(interrupt.targetPgid, terminal.pid)
    }
  }
  await until(() => output.includes('__INTERRUPTED__'))
  assert(alive(tree.root) && alive(tree.descendant))
  await terminal.write('ping\r')
  await until(() => output.includes('__PONG__:3'))
  await terminal.terminate()
  await until(() => !alive(tree.root) && !alive(tree.descendant))
  assert(terminal.output.readableEnded)
  console.log(JSON.stringify({ open: true, persistentInput: true, interrupted: true, inputAfterInterrupt: true,
    rootExited: true, descendantExited: true, outputEnded: true }))
} finally {
  await ctx.fiber.dispose()
  uninstall()
  await rm(root, { recursive: true, force: true })
}
