/** Real-Loader writer transcript with only the model response replaced. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, CallId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { resolveConfig, runGit } from '@deepseek-ai/dsh-task-worktree-local'
import { foldSubagentWorktree } from '@deepseek-ai/dsh-subagent-spawn-in-process'

const barrier = Promise.withResolvers<undefined>()
class FixtureModel extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    await barrier.promise
    const name = JSON.stringify(options.messages).includes('writer-a') ? 'writer-a' : 'writer-b'
    if (options.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `${name} done` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${name} done` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: {
        type: 'tool-call', id: CallId(`${name}-write`), name: 'write',
        arguments: JSON.stringify({ file_path: 'writer.txt', content: name }),
      } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    }
  }
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('isolated-writer-driver requires a config path')
const uninstallFailLoud = installFailLoud('isolated-writer-driver')
let ctx: Context | undefined
try {
  ctx = await boot('isolated-writer-driver', resolveConfigPath(configPath, undefined))
  const runtime = ctx
  const executable = await runtime.subprocess.resolveExecutable('git')
  const limits = resolveConfig({ minFreeBytes: 0 })
  const git = async (cwd: string, args: readonly string[]) => runGit(runtime.subprocess, executable, cwd, args, limits)
  const source = join(process.cwd(), 'source')
  await mkdir(source)
  await git(source, ['init'])
  await git(source, ['config', 'core.autocrlf', 'false'])
  await git(source, ['config', 'user.name', 'Writer Fixture'])
  await git(source, ['config', 'user.email', 'fixture@localhost'])
  await writeFile(join(source, 'tracked.txt'), 'base\n')
  await git(source, ['add', '.'])
  await git(source, ['commit', '-m', 'base'])
  runtime.llm.registerAdapter(['fixture'], new FixtureModel())
  const integration = await runtime.taskWorktrees.create({ taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'), workspacePath: source })
  const parent = await runtime.agents.create({
    sessionId: integration.taskId, meta: { cwd: integration.path },
    agentOptions: { provider: 'fixture', model: 'fixture' },
    setup(scope) { (scope.agent as Agent).session.append('task/worktree-assigned', { assignment: integration }) },
  })
  const startWriter = (name: string) => runtime.subagents.start('writer', {
    parent: parent.agent, label: name, prompt: [{ type: 'text', text: name }], signal: new AbortController().signal,
  })
  const [a, b] = await Promise.all([startWriter('writer-a'), startWriter('writer-b')])
  const first = runtime.agents.get(a.id)!
  const second = runtime.agents.get(b.id)!
  const firstWorkspace = foldSubagentWorktree(first.session.events)!
  const secondWorkspace = foldSubagentWorktree(second.session.events)!
  const output = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
  output({ stage: 'published', bothRunning: first.status === 'running' && second.status === 'running',
    separateDirectories: firstWorkspace.assignment.path !== secondWorkspace.assignment.path,
    sameBase: firstWorkspace.assignment.baseCommit === secondWorkspace.assignment.baseCommit,
    parentRecorded: firstWorkspace.parentTaskId === parent.agent.id && secondWorkspace.parentTaskId === parent.agent.id })
  barrier.resolve(undefined)
  const results = await Promise.all([a.result, b.result])
  output({ stage: 'written', stopReasons: results.map(result => result.stopReason),
    independentContents: await readFile(join(firstWorkspace.assignment.path, 'writer.txt'), 'utf8') === 'writer-a'
      && await readFile(join(secondWorkspace.assignment.path, 'writer.txt'), 'utf8') === 'writer-b',
    rootUnchanged: (await git(integration.path, ['status', '--porcelain=v1'])).stdout === '',
    sourceUnchanged: (await git(source, ['status', '--porcelain=v1'])).stdout === '' })
  await Promise.all([a.dispose(), b.dispose()])
  const cold = await runtime.sessionPersistence.inspect(a.id)
  output({ stage: 'cold-inspection', assignmentRetained: JSON.stringify(foldSubagentWorktree(cold.events)) === JSON.stringify(firstWorkspace),
    cwdRetained: cold.meta.cwd === firstWorkspace.assignment.path, childGone: runtime.agents.get(a.id) === undefined })
  await parent.dispose()
} catch (error: unknown) {
  barrier.resolve(undefined)
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
