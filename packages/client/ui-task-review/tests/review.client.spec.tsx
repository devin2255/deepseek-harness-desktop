// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type {
  SessionId, TaskListState, TaskReviewState, TaskReviewSummary, TaskSnapshot, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { sanitizeDiffText, TaskReview, type TaskReviewProps } from '../src/client/TaskReview.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const taskId = 'root' as SessionId
const revision = 'a'.repeat(64) as TaskReviewSummary['revision']
const t = ((key: keyof typeof en, params?: Record<string, string | number>) => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}) as TaskReviewProps['t']

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId, workspaceId: 'workspace' as never,
    executionWorkspace: {
      kind: 'git-worktree', taskId, workspaceId: 'workspace' as never,
      sourcePath: 'D:\\source', path: 'D:\\worktree', branch: 'dsh/task-root',
      baseCommit: '0'.repeat(40), sourceHead: '0'.repeat(40), sourceDirty: false,
      sourceStatusDigest: 'b'.repeat(64), createdAt: 1,
    },
    definition: { goal: 'Ship the review workspace', criteria: [
      { id: 'one' as never, text: 'Tests pass', status: 'satisfied', evidence: [{ sessionId: taskId, seq: 7 }] },
      { id: 'two' as never, text: 'Docs updated', status: 'pending', evidence: [] },
      { id: 'three' as never, text: 'Legacy waived', status: 'waived', evidence: [] },
    ] },
    descendantSessionIds: [], status: 'ready', freshness: 'live', reviewDecision: 'ready',
    attention: [], risks: [
      { id: 'r0' as never, severity: 'critical', summary: 'Data loss' },
      { id: 'r1' as never, severity: 'high', summary: 'Signing remains' },
      { id: 'r2' as never, severity: 'medium', summary: 'Large patch' },
      { id: 'r3' as never, severity: 'low', summary: 'Minor copy' },
    ], updatedAt: 1, asOfSeq: 4, ...over,
  }
}

function summary(over: Partial<TaskReviewSummary> = {}): TaskReviewSummary {
  return {
    taskId, workspaceId: 'workspace' as never, revision,
    baseCommit: '0'.repeat(40), headCommit: '1'.repeat(40), sourceHead: '0'.repeat(40), sourceDirty: false,
    branch: 'dsh/task-root', dirty: true, truncated: false,
    files: [
      { path: 'src/app.ts', previousPath: 'src/old.ts', status: 'renamed', binary: false, additions: 2, deletions: 1 },
      { path: 'assets/logo.png', status: 'modified', binary: true, additions: null, deletions: null },
    ], additions: 2, deletions: 1, ...over,
  }
}

function harness(over: Partial<TaskReviewState> = {}, taskOver: Partial<TaskSnapshot> = {}): TaskReviewProps {
  const row = task(taskOver)
  const review: TaskReviewState = {
    taskId, state: 'ready', diffState: 'ready', freshness: 'fresh', summary: summary(), selectedPath: 'src/app.ts',
    diff: { taskId, workspaceId: 'workspace' as never, revision, path: 'src/app.ts', binary: false, truncated: false, patch: '@@ -1 +1 @@\n-old\n+new\u001b[31m\n' },
    error: null, operation: null, result: null, ...over,
  }
  const taskList: TaskListState = {
    ids: [taskId], byId: { [taskId]: row }, phase: 'ready', state: 'idle', error: null, freshness: 'fresh', generation: 1,
  }
  const workspaces: WorkspaceListState = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined,
  }
  return {
    useSessions: (() => undefined) as never,
    useWorkspaces: selector => selector(workspaces),
    useTasks: selector => selector(taskList),
    useTaskReview: selector => selector(review),
    showTasks: vi.fn(), refresh: vi.fn(async () => {}), selectFile: vi.fn(async () => {}),
    requestChanges: vi.fn(async () => ({})), commit: vi.fn(async () => ({})),
    apply: vi.fn(async () => ({})), discard: vi.fn(async () => ({})), t,
  }
}

describe('TaskReview', () => {
  it('renders branch facts, changed files, sanitized unified diff, criteria, evidence, and risks', async () => {
    const p = harness()
    const view = render(<TaskReview {...p} />)
    expect(view.getByRole('heading', { name: 'Ship the review workspace' })).toBeTruthy()
    expect(view.getByText(/dsh\/task-root/)).toBeTruthy()
    expect(view.getByRole('navigation', { name: 'Changed files' })).toBeTruthy()
    expect(view.getByRole('button', { name: /src\/app\.ts/ }).getAttribute('aria-current')).toBe('true')
    expect(view.getByLabelText('src/app.ts').textContent).toContain('+new')
    expect(view.getByLabelText('src/app.ts').textContent).not.toContain('\u001b')
    expect(view.getByText('Satisfied')).toBeTruthy()
    expect(view.getByText(/root · #7/)).toBeTruthy()
    expect(view.getByText('Signing remains')).toBeTruthy()
    expect(view.getByText('Data loss')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /assets\/logo\.png/ }))
    await waitFor(() => { expect(p.selectFile).toHaveBeenCalledWith('assets/logo.png') })
    fireEvent.click(view.getByRole('button', { name: /Back to Tasks/ }))
    expect(p.showTasks).toHaveBeenCalledOnce()
  })

  it('keeps loading, stale, truncated, binary, empty, conflict, and retry states explicit', async () => {
    let p = harness({ state: 'loading', summary: null, diff: null, selectedPath: undefined, diffState: 'idle' })
    const view = render(<TaskReview {...p} />)
    expect(view.getByText('Loading review…')).toBeTruthy()
    p = harness({ freshness: 'stale', summary: summary({ truncated: true, sourceDirty: true }), diff: {
      taskId, workspaceId: 'workspace' as never, revision, path: 'assets/logo.png', binary: true, truncated: true, patch: '',
    } })
    view.rerender(<TaskReview {...p} />)
    expect(view.getByText(/Disconnected/)).toBeTruthy()
    expect(view.getAllByText(/truncated/).length).toBeGreaterThan(0)
    expect(view.getByText(/Binary files/)).toBeTruthy()
    expect(view.getByText(/Source workspace had uncommitted/)).toBeTruthy()
    p = harness({ state: 'ready', summary: summary({ files: [], additions: 0, deletions: 0 }), selectedPath: undefined, diff: null, diffState: 'idle' })
    view.rerender(<TaskReview {...p} />)
    expect(view.getByText(/no file changes/)).toBeTruthy()
    p = harness({ error: {
      code: 'task-review-rejected', message: 'raw conflict', details: { sessionId: taskId, reviewCode: 'REVIEW_APPLY_CONFLICT' },
    } })
    view.rerender(<TaskReview {...p} />)
    expect(view.getByRole('alert').textContent).toContain('source workspace was left unchanged')
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    await waitFor(() => { expect(p.refresh).toHaveBeenCalledOnce() })
  })

  it('confirms all four actions and explains dirty discard recovery', async () => {
    const p = harness()
    const view = render(<TaskReview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Request Changes' }))
    expect((await view.findByRole('dialog')).textContent).toContain('returns to execution')
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(p.requestChanges).toHaveBeenCalledWith(4)
    fireEvent.change(view.getByLabelText('Commit message'), { target: { value: 'feat: reviewed' } })
    fireEvent.click(view.getByRole('button', { name: 'Create Commit' }))
    expect(view.getByRole('dialog').textContent).toContain('does not modify your project directory')
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(p.commit).toHaveBeenCalledWith('feat: reviewed', 4)
    fireEvent.click(view.getByRole('button', { name: 'Discard Worktree' }))
    expect(view.getByRole('dialog').textContent).toContain('unrecoverable')
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }))
  })

  it('enables Apply only from a durable commit and shows delivery receipts', async () => {
    const commitReceipt = {
      kind: 'commit' as const, operationId: 'operation' as never, taskId, workspaceId: 'workspace' as never,
      reviewRevision: revision, committedRevision: 'b'.repeat(64) as never, branch: 'dsh/task-root', commit: '2'.repeat(40), committedAt: 2,
    }
    const p = harness({}, { status: 'settled', commitReceipt })
    const view = render(<TaskReview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Apply to Project' }))
    expect(view.getByRole('dialog').textContent).toContain('three-way conflict preflight')
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(p.apply).toHaveBeenCalledWith('2'.repeat(40), 4)

    const discarded = task({ status: 'settled', commitReceipt, discardReceipt: {
      kind: 'discard', operationId: 'discard' as never, taskId, workspaceId: 'workspace' as never,
      reviewRevision: revision, branch: 'dsh/task-root', branchPreserved: true, worktreeRemoved: true,
      uncommittedChangesDiscarded: false, recoverableCommit: '2'.repeat(40), discardedAt: 3,
    } })
    const next = harness({ result: discarded })
    view.rerender(<TaskReview {...next} />)
    expect(view.getByText('The task worktree was removed.')).toBeTruthy()
    expect(view.getByText(/Recoverable commit/)).toBeTruthy()
  })

  it('refreshes from the header and reports ordinary retryable errors', async () => {
    const p = harness({ error: {
      code: 'internal', message: 'Connection interrupted', details: {},
    } })
    const view = render(<TaskReview {...p} />)
    expect(view.getByRole('alert').textContent).toContain('Connection interrupted')
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(p.refresh).toHaveBeenCalledOnce() })
  })

  it('shows fallbacks when task details, criteria, evidence, risks, or a diff are unavailable', () => {
    const p = harness({ taskId: undefined, result: null, diff: null, diffState: 'idle' })
    const { useTasks: _useTasks, ...withoutTasks } = p
    const view = render(<TaskReview {...withoutTasks} />)
    expect(view.getByRole('heading', { name: 'Change Review' })).toBeTruthy()
    expect(view.getByText('No acceptance criteria were defined.')).toBeTruthy()
    expect(view.getByText('No verification evidence yet.')).toBeTruthy()
    expect(view.getByText('No unresolved risks.')).toBeTruthy()
    expect(view.getByText('Select a file to inspect its diff.')).toBeTruthy()
  })

  it('renders diff headers as context and exposes a loading patch state', () => {
    const p = harness({ diff: {
      taskId, workspaceId: 'workspace' as never, revision, path: 'src/app.ts', binary: false, truncated: false,
      patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new',
    } })
    const view = render(<TaskReview {...p} />)
    expect(view.getByLabelText('src/app.ts').textContent).toContain('+++ b/src/app.ts')
    view.rerender(<TaskReview {...harness({ diff: null, diffState: 'loading' })} />)
    expect(view.getByText('Loading file diff…')).toBeTruthy()
  })

  it('confirms clean and dirty discard and ignores confirmation after its task disappears', () => {
    const clean = harness({ summary: summary({ dirty: false }) })
    const view = render(<TaskReview {...clean} />)
    fireEvent.click(view.getByRole('button', { name: 'Discard Worktree' }))
    expect(view.getByRole('dialog').textContent).toContain('Existing commits remain recoverable')
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(clean.discard).toHaveBeenCalledWith(false, 4)

    const dirty = harness()
    view.rerender(<TaskReview {...dirty} />)
    fireEvent.click(view.getByRole('button', { name: 'Discard Worktree' }))
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(dirty.discard).toHaveBeenCalledWith(true, 4)

    view.rerender(<TaskReview {...dirty} />)
    fireEvent.click(view.getByRole('button', { name: 'Request Changes' }))
    const missing = harness({ taskId: undefined, result: null })
    const { useTasks: _missingTasks, ...withoutMissingTasks } = missing
    view.rerender(<TaskReview {...withoutMissingTasks} />)
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(missing.requestChanges).not.toHaveBeenCalled()

    view.rerender(<TaskReview {...dirty} />)
    fireEvent.click(view.getByRole('button', { name: 'Discard Worktree' }))
    const noSummary = harness({ summary: null })
    view.rerender(<TaskReview {...noSummary} />)
    fireEvent.click(view.getByRole('button', { name: 'Confirm' }))
    expect(noSummary.discard).not.toHaveBeenCalled()
  })

  it('shows each durable success state', () => {
    const commitReceipt = {
      kind: 'commit' as const, operationId: 'operation' as never, taskId, workspaceId: 'workspace' as never,
      reviewRevision: revision, committedRevision: 'b'.repeat(64) as never, branch: 'dsh/task-root', commit: '2'.repeat(40), committedAt: 2,
    }
    const view = render(<TaskReview {...harness({ result: task({ commitReceipt }) })} />)
    expect(view.getByText('Task changes were committed.')).toBeTruthy()
    const resultFallback = harness({ result: task({ commitReceipt }) })
    resultFallback.useTasks = selector => selector({
      ids: [], byId: {}, phase: 'ready', state: 'idle', error: null, freshness: 'fresh', generation: 1,
    })
    view.rerender(<TaskReview {...resultFallback} />)
    expect(view.getByRole('heading', { name: 'Ship the review workspace' })).toBeTruthy()
    view.rerender(<TaskReview {...harness({ result: task({ commitReceipt, applyReceipt: {
      kind: 'apply', operationId: 'apply' as never, taskId, workspaceId: 'workspace' as never,
      reviewRevision: revision, sourceHeadBefore: '0'.repeat(40), sourceHeadAfter: '2'.repeat(40), commit: '2'.repeat(40), appliedAt: 3,
    } }) })} />)
    expect(view.getByText('The task commit was safely applied to the project.')).toBeTruthy()
    view.rerender(<TaskReview {...harness({ result: task({ reviewDecision: 'changes-requested' }) })} />)
    expect(view.getByText('Changes were requested from the Agent.')).toBeTruthy()
  })

  it('keeps commit disabled for a whitespace-only message and reports busy work', () => {
    const p = harness({ operation: 'commit' })
    const view = render(<TaskReview {...p} />)
    fireEvent.change(view.getByLabelText('Commit message'), { target: { value: '   ' } })
    expect((view.getByRole('button', { name: 'Create Commit' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByText('Working…')).toBeTruthy()
  })
})

describe('sanitizeDiffText', () => {
  it('removes CSI and unsafe controls while retaining tabs and line breaks', () => {
    expect(sanitizeDiffText('a\u001b[31mred\u001b[0m\n\tb\u0001')).toBe('ared\n\tb')
  })
})
