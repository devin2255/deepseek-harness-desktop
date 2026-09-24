import { describe, expect, it } from 'vitest'
import type {
  SessionId, SessionListState, SessionSummary, TaskListState, TaskSnapshot,
  WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { selectSessionActivity, selectTasks } from '../src/client/select-tasks.ts'

const id = (value: string) => value as SessionId
const summary = (value: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
  id: id(value), displayTitle: value, running: false, blank: false, updatedAt: 1, ...patch,
})
const sessionList = (rows: SessionSummary[], ids = rows.map(row => row.id)): SessionListState => ({
  ids, byId: Object.fromEntries(rows.map(row => [row.id, row])), current: undefined,
  phase: 'ready', state: 'idle', error: null, subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
})
const workspace: WorkspaceView = {
  workspaceId: 'ws' as never, title: 'Registry project', path: '/different', sessionIds: [id('root')],
  createdAt: '0', updatedAt: '0',
}
const workspaces = (items: WorkspaceView[] = [], archivedSessionIds: SessionId[] = []): WorkspaceListState => ({
  items, archivedSessionIds, state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
})
const task = (value: string, patch: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  taskId: id(value), descendantSessionIds: [], status: 'settled', freshness: 'live', attention: [], risks: [],
  updatedAt: 1, asOfSeq: 0, ...patch,
})
const taskList = (rows: TaskSnapshot[]): TaskListState => ({
  ids: rows.map(row => row.taskId), byId: Object.fromEntries(rows.map(row => [row.taskId, row])),
  phase: 'ready', state: 'idle', error: null, freshness: 'fresh', generation: 1,
})

describe('selectTasks', () => {
  it('hides archived roots without removing them from the authoritative Task list', () => {
    const list = taskList([
      task('visible', { descendantSessionIds: [id('child')] }),
      task('archived'),
    ])
    const selected = selectTasks(list, sessionList([summary('visible')]), workspaces([], [id('archived'), id('child')]))
    expect(selected.map(row => row.task.taskId)).toEqual(['visible'])
    expect(list.ids).toEqual([id('visible'), id('archived')])
    expect(list.byId[id('archived')]?.taskId).toBe(id('archived'))
  })

  it('projects all statuses, durable outcome facts, active descendants, workspace, and every attention owner', () => {
    const statuses = ['needs-attention', 'failed', 'running', 'reviewing', 'ready', 'settled'] as const
    const sessions = sessionList([
      summary('needs-attention', { displayTitle: 'Legacy title' }),
      summary('child-running', { origin: 'subagent', parentId: id('needs-attention'), running: true }),
      summary('child-idle', { origin: 'subagent', parentId: id('needs-attention') }),
    ])
    const rows = selectTasks(taskList(statuses.map(status => task(status, status === 'needs-attention' ? {
      status,
      workspaceId: workspace.workspaceId,
      definition: {
        goal: 'Ship the desktop',
        criteria: [
          { id: 'a' as never, text: 'Build', status: 'satisfied', evidence: [{ sessionId: id('needs-attention'), seq: 1 }] },
          { id: 'b' as never, text: 'Verify', status: 'waived', evidence: [] },
          { id: 'c' as never, text: 'Package', status: 'pending', evidence: [] },
        ],
      },
      descendantSessionIds: [id('child-running'), id('child-idle')],
      risks: [
        { id: 'r1' as never, severity: 'high', summary: 'Installer' },
        { id: 'r2' as never, severity: 'low', summary: 'Docs', resolution: 'Done' },
      ],
      attention: [
        { id: 'q' as never, taskId: id('needs-attention'), ownerSessionId: id('child-running'), kind: 'question', severity: 'warning', summary: 'Choose path', createdAt: 1, sourceId: 'q', actionable: true },
        { id: 'v' as never, taskId: id('needs-attention'), ownerSessionId: id('needs-attention'), kind: 'validation-failure', severity: 'error', summary: 'Tests failed', createdAt: 2, sourceId: 'v', actionable: true },
      ],
    } : { status }))), sessions, workspaces([workspace]))

    expect(rows.map(row => row.task.status)).toEqual(statuses)
    expect(rows[0]).toMatchObject({
      goal: 'Ship the desktop', group: 'needs-you', activeDescendants: 1,
      criterionProgress: { completed: 2, total: 3 }, unresolvedRiskCount: 1, workspace,
    })
    expect(rows[0]?.attention.map(entry => [entry.item.kind, entry.owner?.id]))
      .toEqual([['question', 'child-running'], ['validation-failure', 'needs-attention']])
    expect(rows[1]?.group).toBe('needs-you')
    expect(rows[2]?.group).toBe('running')
  })

  it('keeps the explicit legacy Session activity selector for ordinary Web composition', () => {
    const rows = [
      summary('root', { cwd: '/unrelated', pendingInteraction: 'approval' }),
      summary('blank', { blank: true }),
      summary('archived'),
      summary('child', { origin: 'subagent', parentId: id('root'), running: true, pendingInteraction: 'question' }),
    ]
    const selected = selectSessionActivity(
      sessionList(rows, [id('root'), id('blank'), id('archived'), id('child')]),
      workspaces([workspace], [id('archived')]),
    )
    expect(selected).toHaveLength(1)
    expect(selected[0]).toMatchObject({ group: 'needs-you', runningDescendants: 1, workspace })
    expect(selected[0]?.pending.map(row => row.id)).toEqual(['root', 'child'])
  })

  it('orders legacy activity by attention, execution, update time, and root ID', () => {
    const rows = [
      summary('idle-z', { updatedAt: 2 }),
      summary('idle-a', { updatedAt: 2 }),
      summary('idle-old', { updatedAt: 1 }),
      summary('running-root', { running: true }),
      summary('running-child'),
      summary('needs-you', { pendingInteraction: 'approval' }),
      summary('child-one', { origin: 'subagent', parentId: id('running-child'), running: true }),
      summary('child-two', { origin: 'subagent', parentId: id('running-child') }),
      summary('orphan', { origin: 'subagent' }),
    ]
    const selected = selectSessionActivity(sessionList(rows), workspaces())

    expect(selected.map(row => [row.root.id, row.group])).toEqual([
      ['needs-you', 'needs-you'],
      ['running-child', 'running'],
      ['running-root', 'running'],
      ['idle-a', 'other'],
      ['idle-z', 'other'],
      ['idle-old', 'other'],
    ])
    expect(selected.find(row => row.root.id === id('running-child'))?.runningDescendants).toBe(1)
  })
})
