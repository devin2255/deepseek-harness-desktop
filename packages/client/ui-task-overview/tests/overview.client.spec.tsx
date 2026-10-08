// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type {
  SessionId, SessionListState, TaskListState, TaskSnapshot, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { SessionCreateError } from '@deepseek-ai/dsh-client-runtime/client'
import { TaskOverview, type TaskOverviewProps } from '../src/client/TaskOverview.tsx'
import { TasksAction } from '../src/client/TasksAction.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
const t = ((key: keyof typeof en, params?: Record<string, string | number>) => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params ?? {})) value = value.replaceAll(`{${name}}`, String(replacement))
  return value
}) as TaskOverviewProps['t']
function props(): TaskOverviewProps {
  const list: SessionListState = { ids: ['root' as never], byId: {
    ['root' as SessionId]: { id: 'root' as SessionId, displayTitle: 'Root task', blank: false, running: false, updatedAt: 1, pendingInteraction: 'approval', completed: true },
    ['child' as SessionId]: { id: 'child' as SessionId, displayTitle: 'Child task', blank: false, running: true, updatedAt: 1, origin: 'subagent', parentId: 'root' as SessionId, pendingInteraction: 'question' },
    ['grandchild' as SessionId]: { id: 'grandchild' as SessionId, displayTitle: 'Plan child', blank: false, running: false, updatedAt: 1, origin: 'subagent', parentId: 'child' as SessionId, pendingInteraction: 'plan-review' },
  }, phase: 'ready', state: 'idle', error: null, current: undefined, subagentsByParent: {}, currentAddress: undefined, jobsBySession: {} }
  const workspaces: WorkspaceListState = { items: [{ workspaceId: 'ws' as never, title: 'Project', path: '/code', sessionIds: ['root' as never], createdAt: '0', updatedAt: '0' }], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: 'ws' as never }
  const task: TaskSnapshot = {
    taskId: 'root' as SessionId, workspaceId: 'ws' as never,
    executionWorkspace: {
      kind: 'git-worktree', taskId: 'root' as SessionId, workspaceId: 'ws' as never,
      sourcePath: 'D:\\code', path: 'D:\\app-data\\worktrees\\root', branch: 'dsh/task-000000000000000000000000',
      baseCommit: 'a'.repeat(40), sourceHead: 'a'.repeat(40), sourceDirty: false,
      sourceStatusDigest: 'b'.repeat(64), createdAt: 1,
    },
    definition: { goal: 'Ship desktop', criteria: [
      { id: 'done' as never, text: 'Built', status: 'satisfied', evidence: [{ sessionId: 'root' as SessionId, seq: 1 }] },
      { id: 'next' as never, text: 'Packaged', status: 'pending', evidence: [] },
    ] },
    descendantSessionIds: ['child' as SessionId, 'grandchild' as SessionId], status: 'needs-attention',
    freshness: 'live', risks: [{ id: 'risk' as never, severity: 'high', summary: 'Signing' }],
    attention: [
      { id: 'approval' as never, taskId: 'root' as SessionId, ownerSessionId: 'root' as SessionId, kind: 'approval', severity: 'warning', summary: 'Allow command', createdAt: 1, sourceId: 'a', actionable: true },
      { id: 'question' as never, taskId: 'root' as SessionId, ownerSessionId: 'child' as SessionId, kind: 'question', severity: 'warning', summary: 'Choose mode', createdAt: 2, sourceId: 'q', actionable: true },
      { id: 'plan' as never, taskId: 'root' as SessionId, ownerSessionId: 'grandchild' as SessionId, kind: 'plan-review', severity: 'info', summary: 'Review plan', createdAt: 3, sourceId: 'p', actionable: true },
    ], updatedAt: 1, asOfSeq: 2,
  }
  const tasks: TaskListState = {
    ids: [task.taskId], byId: { [task.taskId]: task }, phase: 'ready', state: 'idle', error: null,
    freshness: 'fresh', generation: 1,
  }
  return {
    useSessions: selector => selector(list), useWorkspaces: selector => selector(workspaces),
    useTasks: selector => selector(tasks),
    useHostDescription: selector => selector({} as never),
    useDesktopNavigationFailure: selector => selector(undefined),
    useStudioAvailable: selector => selector(true),
    openTask: vi.fn(async () => {}), openReview: vi.fn(async () => {}), openStudio: vi.fn(),
    startTask: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    archiveTask: vi.fn(async () => {}), restoreTask: vi.fn(async () => {}), t,
  }
}

describe('TaskOverview', () => {
  it.each(['merge-conflict', 'delivery-unconfirmed'] as const)('opens root review for %s instead of a conversation', async (kind) => {
    const p = props()
    const state = p.useTasks!(value => value)!
    const task = state.byId['root' as SessionId]!
    p.useTasks = selector => selector({ ...state, byId: { ...state.byId, ['root' as SessionId]: { ...task,
      ...(kind === 'merge-conflict' ? { integrations: [{ id: 'root:integration:1' as never,
        callSeq: 1, startedAt: 1, writerSessionIds: [], outcome: { kind: 'unconfirmed' as const } }] } : {}),
      attention: [{ ...task.attention[0]!, kind, summary: 'src/shared.ts' }],
    } } })
    const view = render(<TaskOverview {...p} />)
    if (kind === 'merge-conflict') expect(view.getByRole('button', { name: 'Review changes' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: new RegExp(`${en[`attention.${kind}`]}: src/shared.ts`) }))
    await waitFor(() => { expect(p.openReview).toHaveBeenCalledExactlyOnceWith('root') })
    expect(p.openTask).not.toHaveBeenCalled()
  })

  it('opens the selected task runtime from the overview', () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Inspect runtime' }))
    expect(p.openStudio).toHaveBeenCalledExactlyOnceWith('root')
  })
  it('hides runtime inspection when the optional Studio slot is absent', () => {
    const p = props()
    p.useStudioAvailable = selector => selector(false)
    const view = render(<TaskOverview {...p} />)
    expect(view.queryByRole('button', { name: 'Inspect runtime' })).toBeNull()
  })
  it('uses an owner id for attention when its Session summary is unavailable', () => {
    const p = props()
    const sessions = p.useSessions(value => value)
    p.useSessions = selector => selector({ ...sessions, byId: {
      ['root' as SessionId]: sessions.byId['root' as SessionId]!,
    } })
    const view = render(<TaskOverview {...p} />)
    expect(view.getByRole('button', { name: 'child — Question: Choose mode' })).toBeTruthy()
  })

  it('suppresses a superseded navigation error', async () => {
    const p = props()
    let rejectOpen!: (error: unknown) => void
    p.openTask = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOpen = reject }))
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Ship desktop' }))
    await waitFor(() => { expect(p.openTask).toHaveBeenCalledOnce() })
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }))
    rejectOpen(new Error('Superseded navigation'))
    await waitFor(() => { expect(p.refresh).toHaveBeenCalledOnce() })
    expect(view.queryByRole('alert')).toBeNull()
  })

  it('ignores a task-start result that settles after the overview unmounts', async () => {
    for (const outcome of ['resolve', 'reject'] as const) {
      const p = props()
      let resolveStart!: () => void
      let rejectStart!: (error: unknown) => void
      p.startTask = vi.fn(() => new Promise<void>((resolve, reject) => {
        resolveStart = resolve
        rejectStart = reject
      }))
      const view = render(<TaskOverview {...p} />)
      fireEvent.click(view.getByRole('button', { name: 'New Task' }))
      expect(view.getByRole('button', { name: 'Creating…' })).toBeTruthy()
      view.unmount()
      if (outcome === 'resolve') resolveStart()
      else rejectStart(new Error('Task start finished late'))
      await Promise.resolve()
    }
  })

  it('reports ordinary and non-Error task-start failures without offering isolation bypass', async () => {
    const p = props()
    p.startTask = vi.fn(async () => { throw new Error('Task creation failed') })
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'New Task' }))
    expect((await view.findByRole('alert')).textContent).toContain('Task creation failed')
    expect(view.queryByRole('button', { name: 'Use project directly' })).toBeNull()
    p.startTask = vi.fn(async () => { throw 'Unavailable' })
    view.rerender(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'New Task' }))
    await waitFor(() => { expect(view.getByRole('alert').textContent).toContain('Unavailable') })
  })

  it('labels unassigned running and idle ordinary Session activity', () => {
    const p = props()
    const sessions = p.useSessions(value => value)
    const workspaces = p.useWorkspaces(value => value)
    const withoutPending = { ...sessions.byId }
    for (const summary of Object.values(sessions.byId)) {
      const copy = { ...summary }
      delete copy.pendingInteraction
      withoutPending[summary.id] = copy
    }
    delete p.useTasks
    p.useSessions = selector => selector({ ...sessions, byId: withoutPending })
    p.useWorkspaces = selector => selector({ ...workspaces, items: [] })
    const view = render(<TaskOverview {...p} />)
    expect(view.getByText('Unassigned')).toBeTruthy()
    expect(view.getAllByText('Running').length).toBeGreaterThan(1)
    const idleSessions = { ...withoutPending }
    for (const summary of Object.values(withoutPending)) idleSessions[summary.id] = { ...summary, running: false }
    p.useSessions = selector => selector({ ...sessions, byId: idleSessions })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText('Idle')).toBeTruthy()
  })

  it('renders ordinary Session activity without a Task service and distinguishes duplicate pending owners', async () => {
    const p = props()
    const sessions = p.useSessions(value => value)
    const child = sessions.byId['child' as SessionId]!
    delete p.useTasks
    p.useSessions = selector => selector({
      ...sessions,
      byId: {
        [sessions.ids[0]!]: sessions.byId[sessions.ids[0]!]!,
        ['child-111111' as SessionId]: { ...child, id: 'child-111111' as SessionId, displayTitle: 'Duplicate' },
        ['child-112222' as SessionId]: { ...child, id: 'child-112222' as SessionId, displayTitle: 'Duplicate' },
      },
    })
    const view = render(<TaskOverview {...p} />)
    expect(view.getByText('Session activity only')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Inspect runtime' }))
    expect(p.openStudio).toHaveBeenCalledExactlyOnceWith('root')
    expect(view.getByRole('button', { name: 'Duplicate · child-111 — Question' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Duplicate · child-112 — Question' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Root task' }))
    fireEvent.click(view.getByRole('button', { name: 'Duplicate · child-111 — Question' }))
    await waitFor(() => { expect(p.openTask).toHaveBeenCalledWith('child-111111') })
    expect(p.openTask).toHaveBeenCalledWith('root')
  })

  it('renders status transitions and refreshes without losing visible rows', async () => {
    const p = props()
    const sessions = p.useSessions(value => value)
    const workspaces = p.useWorkspaces(value => value)
    const tasks = p.useTasks!(value => value)!
    p.useSessions = selector => selector({ ...sessions, current: 'root' as SessionId })
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(p.refresh).toHaveBeenCalledOnce() })
    fireEvent.change(view.getByLabelText('Workspace for new task'), { target: { value: '' } })
    p.useTasks = selector => selector({ ...tasks, freshness: 'stale' })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText('Task data may be out of date.')).toBeTruthy()
    p.useSessions = selector => selector({ ...sessions, state: 'loading' })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText('Refreshing; displayed information may be out of date.')).toBeTruthy()
    p.useSessions = selector => selector({ ...sessions, state: 'error', error: { code: 'internal', message: 'Session failed', details: {} } })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByRole('alert').textContent).toContain('Session failed')
    p.useSessions = selector => selector(sessions)
    p.useWorkspaces = selector => selector({ ...workspaces, state: 'error', error: { code: 'internal', message: 'Workspace failed', details: {} } })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByRole('alert').textContent).toContain('Workspace failed')
    p.useWorkspaces = selector => selector({ ...workspaces, phase: 'pending' })
    p.useHostDescription = selector => selector(undefined)
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText('Loading tasks and workspaces…')).toBeTruthy()
  })

  it('shows a failed archive without losing the settled Task', async () => {
    const p = props()
    const state = p.useTasks!(value => value)!
    const task = state.byId['root' as SessionId]!
    p.useTasks = selector => selector({ ...state, byId: { [task.taskId]: {
      ...task, status: 'settled', attention: [], descendantSessionIds: [],
    } } })
    p.archiveTask = vi.fn(async () => { throw 'Archive denied' })
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Archive task' }))
    expect((await view.findByRole('alert')).textContent).toContain('Archive denied')
    expect(view.getByRole('button', { name: 'Ship desktop' })).toBeTruthy()
    expect((view.getByRole('button', { name: 'Archive task' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the empty archive and reports a rejected restore without hiding its entry', async () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Show archived tasks' }))
    expect(view.getByText('No archived tasks.')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Hide archived tasks' }))

    const workspaces = p.useWorkspaces(value => value)
    p.useWorkspaces = selector => selector({ ...workspaces, items: [], archivedSessionIds: ['root' as SessionId] })
    p.restoreTask = vi.fn(async () => { throw new Error('Restore denied') })
    view.rerender(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Show archived tasks' }))
    expect(view.getByText('Unassigned')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Restore task' }))
    expect((await view.findByRole('alert')).textContent).toContain('Restore denied')
    expect(view.getByText('Ship desktop')).toBeTruthy()
    expect((view.getByRole('button', { name: 'Restore task' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('archives only settled live tasks and restores archived tasks without opening them', async () => {
    const p = props()
    const useTasks = p.useTasks!
    const state = useTasks(value => value)!
    const task = state.byId['root' as SessionId]!
    p.useTasks = selector => selector({ ...state, byId: { [task.taskId]: {
      ...task, status: 'settled', attention: [], descendantSessionIds: [],
    } } })
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Archive task' }))
    await waitFor(() => { expect(p.archiveTask).toHaveBeenCalledWith('root') })
    const workspaces = p.useWorkspaces(value => value)
    p.useWorkspaces = selector => selector({ ...workspaces, archivedSessionIds: ['root' as SessionId] })
    view.rerender(<TaskOverview {...p} />)
    expect(view.queryByRole('button', { name: 'Ship desktop' })).toBeNull()
    expect(view.getByText('No active tasks; restore one from Archived tasks.')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Show archived tasks' }))
    expect(view.getByText('Ship desktop')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Restore task' }))
    await waitFor(() => { expect(p.restoreTask).toHaveBeenCalledWith('root') })
    expect(p.openTask).not.toHaveBeenCalled()
  })

  it('withholds archive when task needs attention or the projection is stale', () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    expect(view.queryByRole('button', { name: 'Archive task' })).toBeNull()
    const state = p.useTasks!(value => value)!
    const task = state.byId['root' as SessionId]!
    p.useTasks = selector => selector({ ...state, freshness: 'stale', byId: {
      [task.taskId]: { ...task, status: 'settled', attention: [], descendantSessionIds: [] },
    } })
    view.rerender(<TaskOverview {...p} />)
    expect((view.getByRole('button', { name: 'Archive task' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders a desktop notification navigation failure in the overview alert', () => {
    const p = props()
    p.useDesktopNavigationFailure = selector => selector('Notification target is unavailable')

    const view = render(<TaskOverview {...p} />)

    expect(view.getByRole('alert').textContent).toContain('Notification target is unavailable')
  })

  it('renders durable outcome, readiness, freshness, and every attention owner', async () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    expect(view.getByRole('heading', { name: 'Needs You' })).toBeTruthy()
    expect(view.getByRole('heading', { name: 'Running' })).toBeTruthy()
    expect(view.getByRole('heading', { name: 'Other' })).toBeTruthy()
    expect(view.getAllByText('Project').length).toBeGreaterThan(0)
    expect(view.getByRole('button', { name: 'Ship desktop' })).toBeTruthy()
    expect(view.getByText('Needs attention')).toBeTruthy()
    expect(view.getByText('Criteria 1/2')).toBeTruthy()
    expect(view.getByText('1 unresolved risk(s)')).toBeTruthy()
    expect(view.getByText('Live')).toBeTruthy()
    expect(view.getByText('1 known running subagent(s)')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Ship desktop' }))
    await waitFor(() => { expect(p.openTask).toHaveBeenCalledWith('root') })
    fireEvent.click(view.getByRole('button', { name: 'Child task — Question: Choose mode' }))
    await waitFor(() => { expect(p.openTask).toHaveBeenCalledWith('child') })
    expect(view.getByRole('button', { name: 'Root task — Approval: Allow command' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Plan child — Plan review: Review plan' })).toBeTruthy()
    expect(view.getAllByText('Worktree').length).toBeGreaterThan(0)
    expect(view.getByTitle('D:\\app-data\\worktrees\\root').textContent).toBe('Worktree')
    expect(view.getAllByText('Project').length).toBeGreaterThan(0)
  })
  it('creates tasks with worktree isolation or opens the existing setup flow', async () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'New Task' }))
    await waitFor(() => { expect(p.startTask).toHaveBeenCalledWith('ws', 'worktree') })
    const initialWorkspaces = p.useWorkspaces(state => state)
    p.useWorkspaces = selector => selector({ ...initialWorkspaces, items: [], recentWorkspaceId: undefined })
    view.rerender(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'New Task' }))
    await waitFor(() => { expect(p.startTask).toHaveBeenLastCalledWith(undefined, 'worktree') })
  })
  it.each(['reviewing', 'ready', 'settled'] as const)('opens isolated %s tasks in Review', async (status) => {
    const p = props()
    const useTasks = p.useTasks
    if (useTasks === undefined) throw new Error('fixture Task hook missing')
    const state = useTasks(value => value)
    if (state === undefined) throw new Error('fixture Task projection missing')
    const task = state.byId['root' as SessionId]!
    p.useTasks = selector => selector({ ...state, byId: { [task.taskId]: { ...task, status } } })
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Review changes' }))
    await waitFor(() => { expect(p.openReview).toHaveBeenCalledWith('root') })
  })
  it('fails closed and offers explicit isolation recovery with focus management', async () => {
    const p = props()
    p.startTask = vi.fn(async (_workspaceId, isolation) => {
      if (isolation === 'worktree') {
        throw new SessionCreateError({
          code: 'workspace-isolation-unavailable', message: 'Git is unavailable for this project.',
          details: { workspaceId: 'ws', worktreeCode: 'WORKTREE_NOT_GIT' },
        }, undefined)
      }
    })
    const view = render(<TaskOverview {...p} />)
    fireEvent.change(view.getByLabelText('Workspace for new task'), { target: { value: 'ws' } })
    const trigger = view.getByRole('button', { name: 'New Task' })
    fireEvent.click(trigger)
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('Git is unavailable for this project.')
    expect(alert.textContent).toContain('Direct mode lets the Agent modify files')
    expect(document.activeElement).toBe(alert)
    expect(p.startTask).toHaveBeenCalledTimes(1)
    expect(view.getByRole('button', { name: 'Retry isolation' })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Retry isolation' }))
    await waitFor(() => { expect(p.startTask).toHaveBeenCalledTimes(2) })
    fireEvent.click(view.getByRole('button', { name: 'Use project directly' }))
    await waitFor(() => { expect(p.startTask).toHaveBeenLastCalledWith('ws', 'direct') })
    expect(document.activeElement).toBe(trigger)
  })
  it('keeps failed navigation readable and the overview usable', async () => {
    const p = props()
    p.openTask = vi.fn(async () => { throw new Error('Catalog unavailable') })
    const view = render(<TaskOverview {...p} />)
    fireEvent.click(view.getByRole('button', { name: 'Child task — Question: Choose mode' }))
    expect((await view.findByRole('alert')).textContent).toContain('Catalog unavailable')
    expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('distinguishes pending descendants that share a fallback title', () => {
    const p = props()
    const initial = p.useSessions(state => state)
    const useTasks = p.useTasks
    if (useTasks === undefined) throw new Error('fixture Task hook missing')
    const taskState = useTasks(state => state)
    if (taskState === undefined) throw new Error('fixture Task projection missing')
    const task = taskState.byId['root' as SessionId]
    if (task === undefined) throw new Error('fixture Task missing')
    const question = task.attention.find(item => item.kind === 'question')
    if (question === undefined) throw new Error('fixture question missing')
    p.useSessions = selector => selector({
      ...initial,
      byId: {
        ...initial.byId,
        ['child-111111' as SessionId]: {
          ...initial.byId['child' as SessionId]!,
          id: 'child-111111' as SessionId,
          displayTitle: 'fixture',
        },
        ['child-112222' as SessionId]: {
          ...initial.byId['child' as SessionId]!,
          id: 'child-112222' as SessionId,
          displayTitle: 'fixture',
        },
      },
    })
    p.useTasks = selector => selector({
      ...taskState,
      byId: { [task.taskId]: {
        ...task,
        descendantSessionIds: ['child-111111' as SessionId, 'child-112222' as SessionId],
        attention: [
          { ...question, id: 'question-1' as never, ownerSessionId: 'child-111111' as SessionId },
          { ...question, id: 'question-2' as never, ownerSessionId: 'child-112222' as SessionId },
        ],
      } },
    })
    const view = render(<TaskOverview {...p} />)
    expect(view.getByRole('button', { name: 'fixture · child-111 — Question: Choose mode' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'fixture · child-112 — Question: Choose mode' })).toBeTruthy()
  })
  it('distinguishes synchronized empty, initial loading, error, and disconnected stale rows', () => {
    const p = props()
    const useTasks = p.useTasks
    if (useTasks === undefined) throw new Error('fixture Task hook missing')
    const initial = useTasks(s => s)
    if (initial === undefined) throw new Error('fixture Task projection missing')
    p.useTasks = selector => selector({ ...initial, ids: [], byId: {} })
    const view = render(<TaskOverview {...p} />)
    expect(view.getByText('No tasks yet.')).toBeTruthy()
    p.useTasks = selector => selector({ ...initial, ids: [], byId: {}, phase: 'pending', state: 'loading' })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText('Loading tasks and workspaces…')).toBeTruthy()
    expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
    p.useTasks = selector => selector({ ...initial, state: 'error', error: { code: 'task-unavailable', message: 'List denied', details: {} } })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByRole('alert').textContent).toContain('List denied')
    p.useHostDescription = selector => selector(undefined)
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText(/disconnected.*out of date/i)).toBeTruthy()
    expect((view.getByRole('button', { name: 'New Task' }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
    expect(view.getByRole('button', { name: 'Ship desktop' })).toBeTruthy()
  })
  it('labels the ordinary Web fallback without claiming Task facts or freshness', () => {
    const p = props()
    p.useTasks = () => undefined
    const view = render(<TaskOverview {...p} />)
    expect(view.getByText('Session activity only')).toBeTruthy()
    expect(view.queryByText(/Criteria/)).toBeNull()
    expect(view.queryByText(/unresolved risk/)).toBeNull()
    expect(view.queryByText('Live')).toBeNull()
    expect(view.getByRole('button', { name: 'Root task' })).toBeTruthy()
  })
})

it('keeps the Tasks footer accessible in wide and collapsed modes', () => {
  const showHome = vi.fn()
  const p = props()
  const view = render(<TasksAction {...p} wide showHome={showHome} />)
  fireEvent.click(view.getByRole('button', { name: 'Tasks' }))
  expect(showHome).toHaveBeenCalledOnce()
  view.rerender(<TasksAction {...p} wide={false} showHome={showHome} />)
  expect(view.getByRole('button', { name: 'Tasks' })).toBeTruthy()
})
