// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { SessionId, SessionListState, WorkspaceListState } from '@deepseek-ai/dsh-client-runtime/client'
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
  return {
    useSessions: selector => selector(list), useWorkspaces: selector => selector(workspaces),
    useHostDescription: selector => selector({} as never),
    openTask: vi.fn(async () => {}), startTask: vi.fn(), refresh: vi.fn(async () => {}), t,
  }
}

describe('TaskOverview', () => {
  it('renders three groups, registry workspace, pending owners and unread wording', async () => {
    const p = props()
    const view = render(<TaskOverview {...p} />)
    expect(view.getByRole('heading', { name: 'Needs You' })).toBeTruthy()
    expect(view.getByRole('heading', { name: 'Running' })).toBeTruthy()
    expect(view.getByRole('heading', { name: 'Other' })).toBeTruthy()
    expect(view.getAllByText('Project').length).toBeGreaterThan(0)
    expect(view.getByText('Unread activity')).toBeTruthy()
    expect(view.getByText('1 known running subagent(s)')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Child task — Question' }))
    await waitFor(() => { expect(p.openTask).toHaveBeenCalledWith('child') })
    expect(view.getByRole('button', { name: 'Root task — Approval' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Plan child — Plan review' })).toBeTruthy()
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
    fireEvent.click(view.getByRole('button', { name: 'Child task — Question' }))
    expect((await view.findByRole('alert')).textContent).toContain('Catalog unavailable')
    expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false)
  })
  it('distinguishes pending descendants that share a fallback title', () => {
    const p = props()
    const initial = p.useSessions(state => state)
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
    const view = render(<TaskOverview {...p} />)
    expect(view.getByRole('button', { name: 'fixture · child-111 — Question' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'fixture · child-112 — Question' })).toBeTruthy()
  })
  it('distinguishes synchronized empty, initial loading, error, and disconnected stale rows', () => {
    const p = props()
    const initial = p.useSessions(s => s)
    p.useSessions = selector => selector({ ...initial, ids: [], byId: {} })
    const view = render(<TaskOverview {...p} />)
    expect(view.getByText('No tasks yet.')).toBeTruthy()
    p.useSessions = selector => selector({ ...initial, ids: [], byId: {}, phase: 'pending', state: 'loading' })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText('Loading tasks and workspaces…')).toBeTruthy()
    expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
    p.useSessions = selector => selector({ ...initial, state: 'error', error: { code: 'internal', message: 'List denied', details: {} } })
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByRole('alert').textContent).toContain('List denied')
    p.useHostDescription = selector => selector(undefined)
    view.rerender(<TaskOverview {...p} />)
    expect(view.getByText(/disconnected.*out of date/i)).toBeTruthy()
    expect((view.getByRole('button', { name: 'New Task' }) as HTMLButtonElement).disabled).toBe(true)
    expect((view.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true)
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
