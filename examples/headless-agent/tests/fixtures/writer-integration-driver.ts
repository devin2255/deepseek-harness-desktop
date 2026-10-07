/** Real Loader and agent-loop writer review, conflict preflight, and complete integration. */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boot, installFailLoud, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { LlmAdapter, CallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { resolveConfig, runGit } from '@deepseek-ai/dsh-task-worktree-local'
import { foldSubagentWorktree } from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { TaskCommitReceipt, TaskIntegrationResult, TaskReviewSummary } from '@deepseek-ai/dsh-task-review'

let callSequence = 0
function response(name: string, args?: object): StreamChunk[] {
  const block = args === undefined ? { type: 'text' as const, text: name }
    : { type: 'tool-call' as const, id: CallId(`${name}:${++callSequence}`), name, arguments: JSON.stringify(args) }
  return [{ type: 'block-start', index: 0, blockType: block.type },
    { type: 'block-end', index: 0, block }, { type: 'finish', reason: { kind: args === undefined ? 'stop' : 'tool-calls' } }]
}

function result(options: GenerateOptions, name: string): unknown {
  const blocks = options.messages.flatMap(message => message.content)
  const call = blocks.findLast(item => item.type === 'tool-call' && item.name === name)
  if (call?.type !== 'tool-call') throw new Error(`Expected ${name} call`)
  const block = blocks.findLast(item => item.type === 'tool-result' && item.toolCallId === call.id)
  if (block?.type !== 'tool-result' || block.isError) throw new Error(`Expected successful ${name} result: ${JSON.stringify(block)}`)
  return JSON.parse(block.content.filter(item => item.type === 'text').map(item => item.text).join(''))
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('writer-integration-driver requires a config path')
const uninstallFailLoud = installFailLoud('writer-integration-driver')
const barrier = Promise.withResolvers<undefined>()
let ctx: Context | undefined
try {
  ctx = await boot('writer-integration-driver', resolveConfigPath(configPath, undefined))
  const runtime = ctx
  const executable = await runtime.subprocess.resolveExecutable('git')
  const limits = resolveConfig({ minFreeBytes: 0 })
  const git = async (cwd: string, args: readonly string[]) => runGit(runtime.subprocess, executable, cwd, args, limits)
  const source = join(process.cwd(), 'source')
  await mkdir(source)
  await git(source, ['init'])
  await git(source, ['config', 'core.autocrlf', 'false'])
  await git(source, ['config', 'user.name', 'Integration Fixture'])
  await git(source, ['config', 'user.email', 'fixture@localhost'])
  await writeFile(join(source, 'tracked.txt'), 'base\n')
  await git(source, ['add', '.'])
  await git(source, ['commit', '-m', 'base'])
  const integration = await runtime.taskWorktrees.create({ taskId: SessionId('root'), workspaceId: WorkspaceId('workspace'), workspacePath: source })
  const children: SessionId[] = []
  const commits: TaskCommitReceipt[] = []
  let rootRevision = ''
  let rootStep = 0
  let conflictPreserved = false
  let conflict: TaskIntegrationResult | undefined
  let integrated: TaskIntegrationResult | undefined
  const taskInputs = ['root-integration', 'writer-a', 'writer-b', 'writer-c', 'writer-d', 'writer-e']
  class FixtureModel extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      const input = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .findLast(block => block.type === 'text' && taskInputs.includes(block.text))
      if (input?.type !== 'text') throw new Error('Missing explicit integration task input')
      if (input.text !== 'root-integration') {
        await barrier.promise
        const label = input.text
        yield* options.messages.some(message => message.content.some(block => block.type === 'tool-result'))
          ? response(`${label} done`) : response('write', { file_path: label === 'writer-a' || label === 'writer-b' ? 'same.txt' : `${label}.txt`, content: label })
        return
      }
      const step = rootStep++
      if (step < 4 || step >= 5 && step < 9) {
        const position = step < 4 ? Math.floor(step / 2) : Math.floor((step - 5) / 2) + 2
        if (step === 5) {
          conflict = (result(options, 'integrate_agents') as TaskIntegrationResult)
          conflictPreserved = (await git(integration.path, ['rev-parse', 'HEAD'])).stdout.trim() === integration.baseCommit
            && (await git(integration.path, ['status', '--porcelain=v1'])).stdout === ''
        }
        const reviewStep = step < 4 ? step % 2 === 0 : (step - 5) % 2 === 0
        if (reviewStep) {
          if (position > 0 && step !== 5) commits[position - 1] = (result(options, 'commit_agent_changes') as TaskCommitReceipt)
          yield* response('review_agent_changes', { subagent_id: children[position], path: position < 2 ? 'same.txt' : `writer-${position === 2 ? 'c' : 'd'}.txt` })
        } else {
          const review = (result(options, 'review_agent_changes') as { rootRevision: string; summary: TaskReviewSummary })
          rootRevision = review.rootRevision
          yield* response('commit_agent_changes', { subagent_id: children[position], revision: review.summary.revision, message: 'Writer result' })
        }
      } else if (step === 4 || step === 9) {
        const last = step === 4 ? 1 : 3
        commits[last] = (result(options, 'commit_agent_changes') as TaskCommitReceipt)
        const selected = step === 4 ? [0, 1] : [2, 3]
        yield* response('integrate_agents', { root_revision: rootRevision, message: 'Integrate writers', writers: selected.map(index => ({
          subagent_id: children[index], revision: commits[index]!.committedRevision, commit: commits[index]!.commit,
        })) })
      } else {
        integrated = (result(options, 'integrate_agents') as TaskIntegrationResult)
        yield* response('integration done')
      }
    }
  }
  runtime.llm.registerAdapter(['fixture'], new FixtureModel())
  const parent = await runtime.agents.create({ sessionId: integration.taskId, meta: { cwd: integration.path },
    agentOptions: { provider: 'fixture', model: 'fixture' },
    setup(scope) { (scope.agent as Agent).session.append('task/worktree-assigned', { assignment: integration }) },
  })
  const unpark = runtime.on('agent/pre-step', async ({ agent }, next) => agent === parent.agent ? { kind: 'reject' as const } : next())
  const runs = await Promise.all(['a', 'b', 'c', 'd'].map(label => runtime.subagents.start('writer', {
    parent: parent.agent, label: `writer-${label}`, prompt: [{ type: 'text', text: `writer-${label}` }], signal: new AbortController().signal,
  })))
  children.push(...runs.map(run => run.id))
  barrier.resolve(undefined)
  await Promise.all(runs.map(async (run) => { await run.result; await run.dispose() }))
  await parent.agent.whenIdle()
  unpark()
  parent.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'root-integration' }], source: { kind: 'user' } }))
  await parent.agent.whenIdle()
  const output = (value: object): void => { process.stdout.write(`${JSON.stringify(value)}\n`) }
  output({ stage: 'conflict', reported: conflict?.kind === 'conflict', paths: conflict?.kind === 'conflict' ? conflict.paths : [], rootUnchanged: conflictPreserved })
  output({ stage: 'integrated', reported: integrated?.kind === 'integrated', contributors: integrated?.contributors.length,
    filesPresent: await readFile(join(integration.path, 'writer-c.txt'), 'utf8') === 'writer-c'
      && await readFile(join(integration.path, 'writer-d.txt'), 'utf8') === 'writer-d',
    rootClean: (await git(integration.path, ['status', '--porcelain=v1'])).stdout === '',
    sourceUnchanged: (await git(source, ['rev-parse', 'HEAD'])).stdout.trim() === integration.baseCommit
      && (await git(source, ['status', '--porcelain=v1'])).stdout === '' })
  const events = parent.agent.session.events.filter(event => event.type === 'tool/result')
  output({ stage: 'transcript', reviews: events.filter(event => event.data.message.content[0].toolCallId.startsWith('review_agent_changes:')).length,
    commits: events.filter(event => event.data.message.content[0].toolCallId.startsWith('commit_agent_changes:')).length,
    integrations: events.filter(event => event.data.message.content[0].toolCallId.startsWith('integrate_agents:')).length,
    errors: events.filter(event => event.data.message.content[0].isError).length })
  runtime.on('agent/pre-step', async ({ agent }, next) => agent === parent.agent ? { kind: 'reject' as const } : next())
  const next = await runtime.subagents.start('writer', { parent: parent.agent, label: 'writer-e', prompt: [{ type: 'text', text: 'writer-e' }], signal: new AbortController().signal })
  const assignment = foldSubagentWorktree(runtime.agents.get(next.id)!.session.events)!.assignment
  output({ stage: 'next-wave', usesIntegratedBaseline: integrated?.kind === 'integrated' && assignment.baseCommit === integrated.headAfter })
  await next.result
  await next.dispose()
  await parent.dispose()
} catch (error: unknown) {
  barrier.resolve(undefined)
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
  process.exitCode = 1
} finally {
  await ctx?.fiber.dispose()
  uninstallFailLoud()
}
