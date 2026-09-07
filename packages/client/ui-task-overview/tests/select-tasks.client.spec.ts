import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary, WorkspaceListState, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { selectTasks } from '../src/client/select-tasks.ts'

const id = (value: string) => value as SessionId
const summary = (value: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: id(value), displayTitle: value, running: false, blank: false, updatedAt: 1, ...patch,
})
const workspace: WorkspaceView = { workspaceId: 'ws' as never, title: 'Registry project', path: '/different', sessionIds: [id('root')], createdAt: '0', updatedAt: '0' }
const workspaces = (items: WorkspaceView[] = [], archivedSessionIds: SessionId[] = []): WorkspaceListState => ({ items, archivedSessionIds, state: 'idle', phase: 'ready', error: null, baselinesReady: true, recentWorkspaceId: undefined })
const list = (rows: SessionSummary[], ids = rows.map(row => row.id)): SessionListState => ({ ids, byId: Object.fromEntries(rows.map(row => [row.id, row])), current: undefined, phase: 'ready', state: 'idle', error: null, subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })

describe('selectTasks', () => {
  it('uses only listed ordinary nonblank unarchived roots and registry membership', () => {
    const rows = [summary('root', { cwd: '/unrelated' }), summary('blank', { blank: true }), summary('archived'), summary('child', { origin: 'subagent', parentId: id('root') }), summary('unlisted'), summary('same-cwd', { cwd: '/different' })]
    const selected = selectTasks(list(rows, [id('root'), id('root'), id('blank'), id('archived'), id('child'), id('same-cwd'), id('missing')]), workspaces([workspace], [id('archived')]))
    expect(selected.map(row => row.root.id)).toEqual(['root', 'same-cwd'])
    expect(selected[0]?.workspace).toBe(workspace)
    expect(selected[1]?.workspace).toBeUndefined()
  })

  it('follows only uninterrupted known subagent chains and lists every pending owner', () => {
    const rows = [summary('root', { pendingInteraction: 'approval' }), summary('child', { origin: 'subagent', parentId: id('root'), pendingInteraction: 'question', running: true }), summary('grandchild', { origin: 'subagent', parentId: id('child'), pendingInteraction: 'plan-review' }), summary('fork', { parentId: id('child') }), summary('fork-child', { origin: 'subagent', parentId: id('fork'), running: true }), summary('missing-parent', { origin: 'subagent', parentId: id('missing') }), summary('cycle-a', { origin: 'subagent', parentId: id('cycle-b') }), summary('cycle-b', { origin: 'subagent', parentId: id('cycle-a') })]
    const selected = selectTasks(list(rows, [id('root'), id('fork')]), workspaces())
    expect(selected[0]).toMatchObject({ group: 'needs-you', runningDescendants: 1 })
    expect(selected[0]?.descendants.map(row => row.id)).toEqual(['child', 'grandchild'])
    expect(selected[0]?.pending.map(row => row.id)).toEqual(['root', 'child', 'grandchild'])
    expect(selected[1]?.descendants.map(row => row.id)).toEqual(['fork-child'])
  })

  it('prioritizes pending then running and sorts each group by update time then id', () => {
    const rows = [summary('idle', { updatedAt: 30 }), summary('unread', { completed: true, updatedAt: 20 }), summary('running', { running: true }), summary('pending', { pendingInteraction: 'approval', running: true }), summary('a', { updatedAt: 20 }), summary('b', { updatedAt: 20 }), summary('parent'), summary('descendant', { parentId: id('parent'), origin: 'subagent', running: true })]
    const selected = selectTasks(list(rows), workspaces())
    expect(selected.map(row => [row.root.id, row.group])).toEqual([['pending', 'needs-you'], ['parent', 'running'], ['running', 'running'], ['idle', 'other'], ['a', 'other'], ['b', 'other'], ['unread', 'other']])
  })
})
