/** Isolated one-shot writer preparation and durable execution facts. @module @deepseek-ai/dsh-subagent-spawn-in-process/worktree */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { InProcessRunOptions } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { decodeTaskWorktreeAssignment, TaskWorktreeError } from '@deepseek-ai/dsh-task-worktree'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import type {} from '@deepseek-ai/dsh-task'
import type {} from '@deepseek-ai/dsh-task-review'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-user-approval'

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
 * @returns one-shot creation options with captured workspace-write authority.
 * @throws when authority, root assignment, or required capabilities are absent.
 */
export function isolatedWriterOptions(parent: Agent, signal: AbortSignal): InProcessRunOptions {
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
  return {
    async prepare(sessionId) {
      const baseline = await review.summarize({ assignment: integration }, signal)
      if (baseline.dirty) {
        throw new TaskWorktreeError('Commit the integration worktree before starting isolated writers.', 'WORKTREE_SOURCE_DIRTY')
      }
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
        setup(childCtx) {
          const child = childCtx.agent as Agent
          child.session.append('subagent/worktree-assigned', { parentTaskId, assignment })
        },
      }
    },
  }
}
