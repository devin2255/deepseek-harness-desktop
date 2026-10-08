/** Root integration history reconstructed from durable tool results, without Git authority. */

import { z } from 'zod'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TaskIntegrationNodeId, type TaskIntegrationNode, type TaskIntegrationOutcome } from '@deepseek-ai/dsh-task'
import type { TaskIntegrationResult } from '@deepseek-ai/dsh-task-review'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { TaskSessionInput } from './aggregate.ts'

const text = z.string().min(1).refine(value => value === value.trim())
const revision = z.string().regex(/^[0-9a-f]{64}$/)
const commit = z.string().regex(/^[0-9a-f]{40}$/)
const writer = z.strictObject({ subagent_id: text, revision, commit })
const inputSchema = z.strictObject({ root_revision: revision, message: z.string(), writers: z.array(writer).min(1) })
  .refine(value => new Set(value.writers.map(item => item.subagent_id)).size === value.writers.length)
const contributor = z.strictObject({ sessionId: text, branch: text, commit, reviewRevision: revision })
const common = {
  operationId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
  taskId: text, workspaceId: text, reviewRevision: revision,
  headBefore: commit, contributors: z.array(contributor).min(1),
}
const resultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('integrated'), headAfter: commit, integratedAt: z.number().int().nonnegative() }),
  z.strictObject({ ...common, kind: z.literal('conflict'), conflictingSessionId: text,
    paths: z.array(z.string().min(1).refine(value => !value.includes('\\') && !value.includes('\0')
      && !/^(?:[A-Za-z]:|\/)/.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'))).min(1),
    detectedAt: z.number().int().nonnegative() }),
])

interface Attempt {
  node: TaskIntegrationNode
  input: z.infer<typeof inputSchema> | undefined
  native?: { turn: number; step: number }
  code?: { parentCallId: string; rootCallId: string; arguments: string }
  settled: boolean
  closed: boolean
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return undefined /* Invalid or spilled tool text is not a receipt. */ }
}

function outcome(
  attempt: Attempt, content: SessionEvent<'tool/result'>['data']['message']['content'][0]['content'], isError: boolean,
  root: TaskWorktreeAssignment, children: readonly TaskSessionInput[],
): TaskIntegrationOutcome {
  if (isError) {
    const message = content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
    return { kind: 'failed', message: message || 'Integration tool failed without a diagnostic.' }
  }
  if (content.length !== 1 || content[0]?.type !== 'text' || attempt.input === undefined) return { kind: 'unconfirmed' }
  const decoded = resultSchema.safeParse(parseJson(content[0].text))
  if (!decoded.success) return { kind: 'unconfirmed' }
  const result = decoded.data
  const input = attempt.input
  if (result.taskId !== root.taskId || result.workspaceId !== root.workspaceId || result.reviewRevision !== input.root_revision
    || result.contributors.length !== input.writers.length
    || result.contributors.some((item, index) => {
      const selected = input.writers[index] as z.infer<typeof writer>
      return item.sessionId !== selected.subagent_id || item.commit !== selected.commit || item.reviewRevision !== selected.revision
        || !children.some(child => child.header.id === item.sessionId && child.header.origin === 'subagent' && child.header.parentSession === root.taskId)
    }) || result.kind === 'conflict' && !result.contributors.some(item => item.sessionId === result.conflictingSessionId)) {
    return { kind: 'unconfirmed' }
  }
  const receipt = result as unknown as TaskIntegrationResult
  return receipt.kind === 'integrated' ? { kind: 'integrated', result: receipt } : { kind: 'conflict', result: receipt }
}

/**
 * Reconstruct attempts from the root's full log; live activity alone cannot confirm a publication.
 * @param root - root log and Session identity.
 * @param assignment - recorded root execution assignment, when present.
 * @param children - owned descendants used to verify direct contributor identities.
 * @param running - whether the root currently owns live running activity.
 * @returns ordered detached integration attempts, empty for roots without execution assignments.
 */
export function projectIntegrations(
  root: TaskSessionInput, assignment: TaskWorktreeAssignment | undefined, children: readonly TaskSessionInput[], running: boolean,
): TaskIntegrationNode[] {
  if (assignment === undefined || assignment.taskId !== root.header.id) return []
  const attempts: Attempt[] = []
  const byCall = new Map<string, Attempt>()
  const begin = (id: string, event: SessionEvent, args: unknown, correlation: Pick<Attempt, 'native' | 'code'>): void => {
    const input = inputSchema.safeParse(args)
    const attempt: Attempt = {
      node: { id: TaskIntegrationNodeId(`${root.header.id}:integration:${event.seq}`), callSeq: event.seq, startedAt: event.time,
        writerSessionIds: input.success ? input.data.writers.map(item => SessionId(item.subagent_id)) : [], outcome: { kind: 'unconfirmed' } },
      input: input.success ? input.data : undefined, settled: false, closed: false, ...correlation,
    }
    const previous = byCall.get(id)
    if (previous !== undefined) { previous.node = { ...previous.node, outcome: { kind: 'unconfirmed' } }; previous.closed = true }
    attempts.push(attempt)
    byCall.set(id, attempt)
  }
  const finish = (attempt: Attempt, event: SessionEvent, content: Parameters<typeof outcome>[1], isError: boolean): void => {
    attempt.node = { ...attempt.node, finishedAt: event.time,
      outcome: attempt.settled ? { kind: 'unconfirmed' } : outcome(attempt, content, isError, assignment, children) }
    attempt.settled = true
  }
  for (const event of root.events ?? []) {
    if (event.type === 'tool/call' && event.data.name === 'integrate_agents') {
      begin(event.data.callId, event, parseJson(event.data.arguments), { native: { turn: event.data.turn, step: event.data.step } })
    } else if (event.type === 'tool/code-dispatch-start' && event.data.name === 'integrate_agents') {
      begin(event.data.subCallId, event, event.data.arguments, { code: {
        parentCallId: event.data.parentCallId, rootCallId: event.data.rootCallId, arguments: JSON.stringify(event.data.arguments),
      } })
    } else if (event.type === 'tool/result') {
      const block = event.data.message.content[0]
      const attempt = byCall.get(block.toolCallId)
      if (attempt?.native?.turn === event.data.turn && attempt.native.step === event.data.step) {
        finish(attempt, event, block.content, block.isError === true)
      }
      for (const pending of attempts) if (pending.code?.parentCallId === block.toolCallId) pending.closed = true
    } else if (event.type === 'tool/code-dispatch') {
      const attempt = byCall.get(event.data.subCallId)
      if (event.data.name === 'integrate_agents' && attempt?.code !== undefined
        && attempt.code.parentCallId === event.data.parentCallId && attempt.code.rootCallId === event.data.rootCallId
        && attempt.code.arguments === JSON.stringify(event.data.arguments)) {
        finish(attempt, event, event.data.content, event.data.isError)
      }
    } else if (event.type === 'turn/end') {
      for (const attempt of attempts) attempt.closed = true
    } else if (event.type === 'step/end') {
      for (const attempt of attempts) {
        if (attempt.native?.turn === event.data.turn && attempt.native.step === event.data.step) attempt.closed = true
      }
    }
  }
  const nodes = attempts.map(attempt => !attempt.settled && !attempt.closed && running
    ? { ...attempt.node, outcome: { kind: 'running' as const } } : attempt.node)
  return nodes.map((node, index) => {
    if (node.outcome.kind !== 'conflict') return node
    const remaining = new Set(node.writerSessionIds)
    for (const later of nodes.slice(index + 1)) {
      if (later.outcome.kind !== 'integrated') continue
      for (const writer of later.writerSessionIds) remaining.delete(writer)
      if (remaining.size === 0) return { ...node, resolvedBy: later.id }
    }
    return node
  })
}
