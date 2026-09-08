// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type {
  SessionId, SessionListState, TaskListState, TaskSnapshot, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
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
  const workspaces: WorkspaceListState = { items: [{ workspaceId: 'ws' as never, title: 'Project', path: '/code', sessionIds: ['root' as never], createdAt: '0', updatedAt: '0' }], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined }
  const task: TaskSnapshot = {
    taskId: 'root' as SessionId, workspaceId: 'ws' as never,
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
    openTask: vi.fn(async () => {}), startTask: vi.fn(), refresh: vi.fn(async () => {}), t,
  }
}

describe('TaskOverview', () => {
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
    fireEvent.click(view.getByRole('button', { name: 'Child task — Question: Choose mode' }))
    await waitFor(() => { expect(p.openTask).toHaveBeenCalledWith('child') })
    expect(view.getByRole('button', { name: 'Root task — Approval: Allow command' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Plan child — Plan review: Review plan' })).toBeTruthy()
    expect(view.getByText(/no automatic worktree isolation/i)).toBeTruthy()
  })
  it('creates tasks with an explicit workspace or the existing setup flow', () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    fireEvent.change(view.getByLabelText('Workspace for new task'), { target: { value: 'ws' } })
    fireEvent.click(view.getByRole('button', { name: 'New Task' }))
    expect(p.startTask).toHaveBeenCalledWith('ws')
    fireEvent.change(view.getByLabelText('Workspace for new task'), { target: { value: '' } })
    fireEvent.click(view.getByRole('button', { name: 'New Task' }))
    expect(p.startTask).toHaveBeenLastCalledWith(undefined)
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
