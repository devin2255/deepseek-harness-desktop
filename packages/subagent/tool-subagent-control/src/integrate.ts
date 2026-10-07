/** Root-owned review, commit, and batch integration of isolated writer results. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskWorktreeAssignment } from '@deepseek-ai/dsh-task-worktree'
import { TaskReviewRevision } from '@deepseek-ai/dsh-task-review'
import { foldSubagentWorktree } from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-task'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import { commitSchema, integrationSchema, reviewSchema } from './integration-schemas.ts'

export const name = 'tool-subagent-integrate'
export const inject = ['tools', 'agents', 'sessions', 'sessionPersistence', 'tasks', 'taskReview', 'sandboxPolicy']

function rootAssignment(ctx: Context, agent: Agent | undefined, writing: boolean): TaskWorktreeAssignment {
  if (agent === undefined || ctx.agents.get(agent.id) !== agent) {
    throw new Error('Writer review requires the registered calling agent.')
  }
  const task = ctx.tasks.snapshot().tasks.find(row => row.taskId === agent.id)
  const assignment = task?.executionWorkspace
  if (agent.session.header.origin === 'subagent' || assignment === undefined || assignment.taskId !== agent.id
    || agent.session.header.cwd !== assignment.path || task?.discardReceipt !== undefined) {
    throw new Error('Only a root Task in its available managed worktree can review writer results.')
  }
  const mode = ctx.sandboxPolicy.resolve({ session: agent.session }).mode
  if (writing && mode !== 'workspace-write' && mode !== 'danger-full-access') {
    throw new Error('The root Task is read-only; writer commits and integration are not permitted.')
  }
  return assignment
}

async function childAssignment(
  ctx: Context, root: TaskWorktreeAssignment, id: SessionId, signal: AbortSignal,
): Promise<TaskWorktreeAssignment> {
  if (ctx.agents.get(id) !== undefined) throw new Error('Wait until the writer has released its active execution before reviewing its result.')
  const live = ctx.sessions.get(id)
  const inspection = live === undefined ? await ctx.sessionPersistence.inspect(id, signal) : { meta: live.header, events: live.events }
  const recorded = foldSubagentWorktree(inspection.events.slice(inspection.meta.seedLength ?? 0))
  if (inspection.meta.origin !== 'subagent' || inspection.meta.parentSession !== root.taskId
    || recorded === undefined || recorded.parentTaskId !== root.taskId || recorded.assignment.taskId !== id
    || recorded.assignment.sourcePath !== root.path || recorded.assignment.workspaceId !== root.workspaceId
    || inspection.meta.cwd !== recorded.assignment.path) {
    throw new Error('The selected result is not a directly owned isolated writer of this root Task.')
  }
  if (ctx.agents.get(id) !== undefined) throw new Error('The writer resumed while its result was being inspected; review it after execution stops.')
  signal.throwIfAborted()
  return recorded.assignment
}

/**
 * Register generic-card tools whose canonical results remain in the ordinary tool transcript.
 * @param ctx - root authority, persisted child ownership, policy, and review Provider.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'review_agent_changes',
    description: 'Inspect a directly owned isolated writer after it stops. Returns its exact review revision, current commit, '
      + 'bounded changed files, and the root integration revision. Supply a file path to read its diff. Review does not commit or merge anything.',
    parameters: {
      subagent_id: { type: 'string', required: true, description: 'The isolated writer id returned when it started.' },
      path: { type: 'string', description: 'Optional repository-relative member file to inspect in this review.' },
    },
    output: { schema: reviewSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const root = rootAssignment(ctx, exec.agent, false)
      const assignment = await childAssignment(ctx, root, SessionId(args.subagent_id), exec.signal)
      const summary = await ctx.taskReview.summarize({ assignment }, exec.signal)
      const diff = args.path === undefined ? undefined : await ctx.taskReview.diff({
        assignment, path: args.path, expectedRevision: summary.revision,
      }, exec.signal)
      const rootReview = await ctx.taskReview.summarize({ assignment: root }, exec.signal)
      rootAssignment(ctx, exec.agent, false)
      return {
        rootRevision: rootReview.revision, summary: { ...summary, files: [...summary.files] },
        ...diff === undefined ? {} : { diff },
      }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'commit_agent_changes',
    description: 'Commit the exact inspected changes of a directly owned stopped isolated writer. Requires its review revision. '
      + 'Returns the committed revision and commit to select for integration. Does not change the root or original project checkout.',
    parameters: {
      subagent_id: { type: 'string', required: true }, revision: { type: 'string', required: true }, message: { type: 'string', required: true },
    },
    output: { schema: commitSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const root = rootAssignment(ctx, exec.agent, true)
      const assignment = await childAssignment(ctx, root, SessionId(args.subagent_id), exec.signal)
      rootAssignment(ctx, exec.agent, true)
      return ctx.taskReview.commit({ assignment, expectedRevision: TaskReviewRevision(args.revision), message: args.message }, exec.signal)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'integrate_agents',
    description: 'Merge a batch of directly owned stopped isolated writers into your root Task worktree. Use the inspected root revision '
      + 'and exact committed child revisions and commits. Root and children must have no uncommitted changes. Every merge is preflighted; '
      + 'a conflict changes no branches or working trees and identifies the conflicting writer and files. Success retains all child branches '
      + 'and leaves the original project checkout unchanged. Cancellation is honored before publication, not during final publication.',
    parameters: {
      root_revision: { type: 'string', required: true }, message: { type: 'string', required: true },
      writers: { type: 'array', required: true, items: {
        type: 'object', additionalProperties: false,
        properties: { subagent_id: { type: 'string', required: true }, revision: { type: 'string', required: true }, commit: { type: 'string', required: true } },
      } },
    },
    output: { schema: integrationSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) {
      const root = rootAssignment(ctx, exec.agent, true)
      const inputs = []
      for (const writer of args.writers) {
        inputs.push({ assignment: await childAssignment(ctx, root, SessionId(writer.subagent_id), exec.signal),
          expectedRevision: TaskReviewRevision(writer.revision), commit: writer.commit })
      }
      rootAssignment(ctx, exec.agent, true)
      const result = await ctx.taskReview.integrate({
        assignment: root, expectedRevision: TaskReviewRevision(args.root_revision), inputs, message: args.message,
      }, exec.signal)
      const contributors = [...result.contributors]
      return result.kind === 'conflict' ? { ...result, contributors, paths: [...result.paths] } : { ...result, contributors }
    },
  }))
}
