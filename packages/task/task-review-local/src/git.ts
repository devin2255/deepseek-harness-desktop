/** Git porcelain parsing specific to local Task review. */

import type { TaskReviewFileStatus } from '@deepseek-ai/dsh-task-review'

/** Parsed tracked-file state from `git diff --name-status -z`. */
export interface GitChangedPath {
  readonly path: string
  readonly previousPath?: string
  readonly status: TaskReviewFileStatus
}

function reviewStatus(code: string): TaskReviewFileStatus {
  if (code.startsWith('A')) return 'added'
  if (code.startsWith('M')) return 'modified'
  if (code.startsWith('D')) return 'deleted'
  if (code.startsWith('R')) return 'renamed'
  if (code.startsWith('C')) return 'copied'
  if (code.startsWith('T')) return 'type-changed'
  if (code.startsWith('U')) return 'conflicted'
  throw new Error(`Unsupported Git file status ${JSON.stringify(code)}`)
}

/**
 * Parse NUL-delimited tracked file changes.
 * @param output - Complete name-status output.
 * @returns Normalized review paths.
 */
export function parseNameStatus(output: string): readonly GitChangedPath[] {
  const fields = output.split('\0')
  const changes: GitChangedPath[] = []
  for (let index = 0; index < fields.length;) {
    const code = fields[index++]
    if (code === undefined || code.length === 0) continue
    const status = reviewStatus(code)
    if (status === 'renamed' || status === 'copied') {
      const previousPath = fields[index++]
      const path = fields[index++]
      if (!previousPath || !path) throw new Error('Git rename record is incomplete')
      changes.push({ path, previousPath, status })
    } else {
      const path = fields[index++]
      if (!path) throw new Error('Git file-status record is incomplete')
      changes.push({ path, status })
    }
  }
  return changes
}

/** Per-file line counts from `git diff --numstat -z`. */
export interface GitNumstat {
  readonly path: string
  readonly additions: number | null
  readonly deletions: number | null
}

function count(value: string): number | null {
  if (value === '-') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Git numstat count is invalid')
  return parsed
}

/**
 * Parse NUL-delimited numstat output, including rename records.
 * @param output - Complete numstat output.
 * @returns Counts keyed by each change's resulting path.
 */
export function parseNumstat(output: string): readonly GitNumstat[] {
  const fields = output.split('\0')
  const results: GitNumstat[] = []
  for (let index = 0; index < fields.length;) {
    const field = fields[index++]
    if (field === undefined || field.length === 0) continue
    const firstTab = field.indexOf('\t')
    const secondTab = field.indexOf('\t', firstTab + 1)
    if (firstTab < 0 || secondTab < 0) throw new Error('Git numstat record is incomplete')
    const additions = count(field.slice(0, firstTab))
    const deletions = count(field.slice(firstTab + 1, secondTab))
    let path = field.slice(secondTab + 1)
    if (path.length === 0) {
      const previousPath = fields[index++]
      const resultingPath = fields[index++]
      if (!previousPath || !resultingPath) throw new Error('Git rename numstat record is incomplete')
      path = resultingPath
    }
    results.push({ path, additions, deletions })
  }
  return results
}
