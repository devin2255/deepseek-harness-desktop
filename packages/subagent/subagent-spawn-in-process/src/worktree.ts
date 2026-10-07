/** Isolated writer preparation and execution validation. @module @deepseek-ai/dsh-subagent-spawn-in-process/worktree */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { InProcessRunOptions } from '@deepseek-ai/dsh-subagent-in-process-driver'
import type { ContinuableExecutionRequest, ContinuableExecutionSpec } from '@deepseek-ai/dsh-subagent'
import { effectiveSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import { effectiveApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { decodeTaskWorktreeAssignment, TaskWorktreeError } from '@deepseek-ai/dsh-task-worktree'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type {} from '@deepseek-ai/dsh-task'
import type {} from '@deepseek-ai/dsh-task-review'

/** Recorded link from one isolated writer to its root integration worktree. */
export interface SubagentWorktreeData {
  readonly parentTaskId: SessionId
  readonly assignment: TaskWorktreeAssignment
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Model-hidden, immutable execution assignment appended before writer publication. */
    'subagent/worktree-assigned': SubagentWorktreeData
  }
}

/**
 * Read the unique isolated-writer assignment from a child's own log.
 * @param events - child's own events, excluding any inherited fork seed.
 * @returns validated execution facts, or undefined for a shared-workspace child.
 * @throws when assignment data is malformed or repeated.
 */
export function foldSubagentWorktree(events: readonly SessionEvent[]): SubagentWorktreeData | undefined {
  const assignments = events.filter(event => event.type === 'subagent/worktree-assigned')
  const [assignment] = assignments
  if (assignment === undefined) return undefined
  if (assignments.length !== 1) throw new Error('subagent worktree assignment must occur exactly once')
  const value: unknown = assignment.data
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'assignment,parentTaskId') {
    throw new Error('subagent worktree data must have exactly assignment,parentTaskId fields')
  }
  const record = value as Record<string, unknown>
  const parentTaskId = record['parentTaskId']
  if (typeof parentTaskId !== 'string' || parentTaskId.length === 0 || parentTaskId !== parentTaskId.trim()) {
    throw new Error('subagent worktree parentTaskId must be non-empty and normalized')
  }
  return { parentTaskId: parentTaskId as SessionId, assignment: decodeTaskWorktreeAssignment(record['assignment']) }
}

/**
 * Capture root authority and prepare a distinct writer checkout without changing its parent.
 * @param parent - delegating root Agent, already executing in an owned Task worktree.
 * @param signal - cancellation shared with child creation.
 * @returns preparation for one reserved child with captured workspace-write authority.
 * @throws when authority, root assignment, or required capabilities are absent.
 */
export function prepareIsolatedWriter(parent: Agent, signal: AbortSignal): (sessionId: SessionId) => Promise<ContinuableExecutionSpec> {
  const policy = parent.ctx.get('sandboxPolicy')
  const approval = parent.ctx.get('approval')
  const tasks = parent.ctx.get('tasks')
  const worktrees = parent.ctx.get('taskWorktrees')
  const review = parent.ctx.get('taskReview')
  if (policy === undefined || approval === undefined || tasks === undefined || worktrees === undefined || review === undefined) {
    throw new Error('isolated subagent writers require sandboxPolicy, approval, tasks, taskWorktrees, and taskReview')
  }
  const mode = policy.resolve({ session: parent.session }).mode
  if (mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new Error('the delegating Task is read-only; an isolated writer cannot gain write authority')
  }
  const root = tasks.snapshot().tasks.find(task => task.taskId === parent.id)
  const integration = root?.executionWorkspace
  if (parent.session.header.origin === 'subagent' || integration === undefined
    || parent.session.header.cwd !== integration.path || root?.discardReceipt !== undefined) {
    throw new Error('only a root Task in its available managed integration worktree can delegate isolated writers')
  }
  const parentTaskId = parent.id
  return async (sessionId) => {
    const baseline = await review.summarize({ assignment: integration }, signal)
    const assignment = await worktrees.create({
      taskId: sessionId,
      workspaceId: integration.workspaceId,
      workspacePath: integration.path,
      expectedSourceHead: baseline.headCommit,
      requireCleanSource: true,
    }, signal)
    return {
      cwd: assignment.path,
      policies: { sandboxMode: 'workspace-write', approvalPolicy: 'never' },
      facts: [{ type: 'subagent/worktree-assigned', data: { parentTaskId, assignment } }],
    }
  }
}

/**
 * Adapt detached writer preparation to the one-shot factory's setup capability.
 * @param parent - delegating root Agent in its managed integration worktree.
 * @param signal - creation cancellation.
 * @returns one-shot execution options preserving the same assignment and authority.
 */
export function isolatedWriterOptions(parent: Agent, signal: AbortSignal): InProcessRunOptions {
  const prepare = prepareIsolatedWriter(parent, signal)
  return { async prepare(sessionId) {
    const execution = await prepare(sessionId)
    return {
      cwd: execution.cwd,
      policies: execution.policies,
      setup(childCtx) {
        const session = (childCtx.agent as Agent).session
        for (const fact of execution.facts) session.append(fact.type, fact.data)
      },
    }
  } }
}

/**
 * Validate the actual unpublished writer and its live registered Git worktree.
 * @param request - actual session metadata and events, direct parent, and cancellation.
 * @returns after execution identity and recorded authority have been verified.
 * @throws when ownership, permissions, required services, or live Git identity are unavailable.
 */
export async function validateIsolatedWriter(request: ContinuableExecutionRequest): Promise<void> {
  const ownEvents = request.events.slice(request.meta.seedLength ?? 0)
  const recorded = foldSubagentWorktree(ownEvents)
  const worktrees = request.parent.ctx.get('taskWorktrees')
  const root = request.parent.ctx.get('tasks')?.snapshot().tasks.find(task => task.taskId === request.parent.id)
  if (recorded === undefined || worktrees === undefined || root?.executionWorkspace === undefined
    || root.discardReceipt !== undefined || request.parent.session.header.origin === 'subagent'
    || recorded.parentTaskId !== request.parent.id || recorded.assignment.taskId !== request.sessionId
    || request.meta.origin !== 'subagent' || request.meta.parentSession !== request.parent.id
    || request.meta.cwd !== recorded.assignment.path
    || recorded.assignment.sourcePath !== root.executionWorkspace.path
    || request.parent.session.header.cwd !== root.executionWorkspace.path) {
    throw new Error('isolated writer execution does not match its available root Task, Session, and directory')
  }
  const mode = effectiveSandboxMode(ownEvents)
  if ((mode !== 'workspace-write' && mode !== 'read-only') || effectiveApprovalPolicy(ownEvents) !== 'never') {
    throw new Error('isolated writer execution requires recorded non-escalating sandbox and approval policies')
  }
  if (await worktrees.inspect(recorded.assignment, request.signal) !== 'available') {
    throw new TaskWorktreeError('The isolated writer worktree is missing or its Git identity changed.', 'WORKTREE_UNAVAILABLE')
  }
}
