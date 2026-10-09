/** Strict decoding of durable execution-worktree identities. @module @deepseek-ai/dsh-task-worktree/assignment */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { TaskWorktreeAssignment } from './types.ts'

const FIELDS = [
  'baseCommit', 'branch', 'createdAt', 'kind', 'path', 'sourceDirty', 'sourceHead',
  'sourcePath', 'sourceStatusDigest', 'taskId', 'workspaceId',
].sort().join(',')

function string(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new Error(`${subject} must be non-empty and normalized`)
  }
  return value
}

function path(value: unknown, subject: string): string {
  const result = string(value, subject)
  if (result.includes('\u0000')) throw new Error(`${subject} must not contain a null character`)
  return result
}

function commit(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${subject} must be a lowercase forty-character Git object id`)
  }
  return value
}

/**
 * Decode a complete recorded worktree assignment without consulting live Git state.
 * @param value - untrusted durable or wire value.
 * @returns detached, validated assignment facts.
 * @throws when fields, identity, paths, Git ids, or timestamps are invalid.
 */
export function decodeTaskWorktreeAssignment(value: unknown): TaskWorktreeAssignment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== FIELDS) {
    throw new Error(`worktree assignment must have exactly ${FIELDS} fields`)
  }
  const record = value as Record<string, unknown>
  if (record['kind'] !== 'git-worktree') throw new Error('worktree kind must be git-worktree')
  const taskId = string(record['taskId'], 'worktree taskId') as SessionId
  const workspaceId = string(record['workspaceId'], 'worktree workspaceId') as WorkspaceId
  const sourcePath = path(record['sourcePath'], 'worktree sourcePath')
  const executionPath = path(record['path'], 'worktree path')
  if (sourcePath === executionPath) throw new Error('worktree path must differ from sourcePath')
  const branch = string(record['branch'], 'worktree branch')
  if (!/^dsh\/task-[0-9a-f]{24}$/.test(branch)) throw new Error('worktree branch is invalid')
  const baseCommit = commit(record['baseCommit'], 'worktree baseCommit')
  const sourceHead = commit(record['sourceHead'], 'worktree sourceHead')
  if (baseCommit !== sourceHead) throw new Error('worktree baseCommit must equal sourceHead')
  if (typeof record['sourceDirty'] !== 'boolean') throw new Error('worktree sourceDirty must be boolean')
  if (typeof record['sourceStatusDigest'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['sourceStatusDigest'])) {
    throw new Error('worktree sourceStatusDigest must be a lowercase SHA-256 digest')
  }
  if (typeof record['createdAt'] !== 'number' || !Number.isSafeInteger(record['createdAt']) || record['createdAt'] < 0) {
    throw new Error('worktree createdAt must be a non-negative safe integer')
  }
  return {
    kind: 'git-worktree', taskId, workspaceId, sourcePath, path: executionPath, branch, baseCommit, sourceHead,
    sourceDirty: record['sourceDirty'], sourceStatusDigest: record['sourceStatusDigest'], createdAt: record['createdAt'],
  }
}
