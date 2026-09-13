/** Desktop task overview over framework-provided runtime metadata. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { SessionCreateError, type SessionId, type TaskListState, type WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { OverviewInjected } from './index.ts'
import {
  selectSessionActivity, selectTasks, type SessionActivityRow, type TaskRow,
} from './select-tasks.ts'
import css from './TaskOverview.module.css'

/** Runtime, locale and injected shares; no business-state store. */
export type TaskOverviewProps = PropsRuntime<'shell.home'> & PropsLocale<'taskOverview'> & InjectFace<OverviewInjected>

const absentTasks = { getSnapshot: () => undefined, subscribe: () => () => {} }

function useAbsentTasks<S>(_selector: (state: TaskListState) => S): S | undefined {
  useSyncExternalStore(absentTasks.subscribe, absentTasks.getSnapshot, absentTasks.getSnapshot)
  return undefined
}

function pendingOwnerTitle(
  owner: SessionActivityRow['pending'][number],
  pending: SessionActivityRow['pending'],
): string {
  const duplicates = pending.filter(candidate => candidate.id !== owner.id
    && candidate.displayTitle === owner.displayTitle
    && candidate.pendingInteraction === owner.pendingInteraction)
  if (duplicates.length === 0) return owner.displayTitle
  let prefixLength = Math.min(8, owner.id.length)
  while (prefixLength < owner.id.length
    && duplicates.some(candidate => candidate.id.startsWith(owner.id.slice(0, prefixLength)))) {
    prefixLength += 1
  }
  return `${owner.displayTitle} · ${owner.id.slice(0, prefixLength)}`
}

function attentionOwnerTitle(entry: TaskRow['attention'][number], attention: TaskRow['attention']): string {
  const title = entry.owner?.displayTitle ?? entry.item.ownerSessionId
  const duplicates = attention.filter(candidate => candidate.item.id !== entry.item.id
    && (candidate.owner?.displayTitle ?? candidate.item.ownerSessionId) === title
    && candidate.item.kind === entry.item.kind)
  if (duplicates.length === 0) return title
  let prefixLength = Math.min(8, entry.item.ownerSessionId.length)
  while (prefixLength < entry.item.ownerSessionId.length
    && duplicates.some(candidate => candidate.item.ownerSessionId
      .startsWith(entry.item.ownerSessionId.slice(0, prefixLength)))) {
    prefixLength += 1
  }
  return `${title} · ${entry.item.ownerSessionId.slice(0, prefixLength)}`
}

/** Overview page with task groups and metadata health. */
export function TaskOverview({
  useSessions, useWorkspaces, useTasks, useHostDescription, openTask, openReview, startTask, refresh, t,
}: TaskOverviewProps) {
  const sessions = useSessions(value => value)
  const workspaces = useWorkspaces(value => value)
  const useTaskProjection = useTasks ?? useAbsentTasks
  const tasks = useTaskProjection(value => value)
  const connected = useHostDescription(value => value !== undefined)
  const taskRows = useMemo(
    () => tasks === undefined ? undefined : selectTasks(tasks, sessions, workspaces),
    [sessions, tasks, workspaces],
  )
  const activityRows = useMemo(
    () => tasks === undefined ? selectSessionActivity(sessions, workspaces) : undefined,
    [sessions, tasks, workspaces],
  )
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId | undefined>()
  const [failure, setFailure] = useState<string>()
  const [recovery, setRecovery] = useState<{ workspaceId: WorkspaceId; message: string }>()
  const [starting, setStarting] = useState(false)
  const startTrigger = useRef<HTMLButtonElement>(null)
  const recoveryPanel = useRef<HTMLDivElement>(null)
  const restoreStartFocus = useRef(false)
  const attempt = useRef(0)
  const startAttempt = useRef(0)
  useEffect(() => () => { attempt.current += 1; startAttempt.current += 1 }, [])
  useEffect(() => { recoveryPanel.current?.focus() }, [recovery])
  useEffect(() => {
    if (!starting && recovery === undefined && restoreStartFocus.current) {
      restoreStartFocus.current = false
      startTrigger.current?.focus()
    }
  }, [recovery, starting])
  const run = (action: () => void | Promise<void>): void => {
    const current = ++attempt.current
    setFailure(undefined)
    void Promise.resolve().then(action).catch((error: unknown) => {
      if (current === attempt.current) setFailure(error instanceof Error ? error.message : String(error))
    })
  }
  const open = (id: SessionId): void => { run(() => openTask(id)) }
  const start = (target: WorkspaceId | undefined, isolation: 'direct' | 'worktree'): void => {
    const current = ++startAttempt.current
    setFailure(undefined)
    setRecovery(undefined)
    setStarting(true)
    void startTask(target, isolation).then(() => {
      if (current !== startAttempt.current) return
      restoreStartFocus.current = true
      setStarting(false)
    }).catch((error: unknown) => {
      if (current !== startAttempt.current) return
      setStarting(false)
      if (target !== undefined && error instanceof SessionCreateError
        && error.rpcError.code === 'workspace-isolation-unavailable') {
        setRecovery({ workspaceId: target, message: error.rpcError.message })
        return
      }
      setFailure(error instanceof Error ? error.message : String(error))
    })
  }
  const initial = sessions.phase === 'pending' || workspaces.phase === 'pending' || tasks?.phase === 'pending'
  const loading = sessions.state === 'loading' || workspaces.state === 'loading' || tasks?.state === 'loading'
  const failed = sessions.state === 'error' || workspaces.state === 'error' || tasks?.state === 'error'
  const synchronized = connected && !initial && !loading && !failed
  const currentSessionId = sessions.current
  const currentWorkspaceId = currentSessionId === undefined
    ? undefined
    : workspaces.items.find(item => item.sessionIds.includes(currentSessionId))?.workspaceId
  const selectedWorkspace = workspaces.items.find(item => item.workspaceId
    === (workspaceId ?? currentWorkspaceId ?? workspaces.recentWorkspaceId))?.workspaceId
  const requestErrors = [sessions.error?.message, workspaces.error?.message, tasks?.error?.message]
    .filter(message => message !== undefined)
  const status = !connected ? t(initial ? 'loading' : 'disconnected')
    : failed ? t('failed') : initial ? t('loading') : loading ? t('refreshing')
      : tasks?.freshness === 'stale' ? t('stale') : undefined
  const rowCount = taskRows?.length ?? activityRows?.length ?? 0

  return (
    <main className={css.root} aria-label={t('tasks')}>
      <div className={css.content}>
        <header className={css.header}>
          <h1 className={css.title}>{t('tasks')}</h1>
          <button type="button" className={css.action} disabled={!connected || loading}
            onClick={() => { run(refresh) }}>{t('refresh')}</button>
        </header>
        <div className={css.toolbar}>
          <label className={css.workspace}>
            {t('workspace')}
            <select className={css.control} value={selectedWorkspace ?? ''} disabled={!connected || loading || starting}
              onChange={(event) => { setWorkspaceId(workspaces.items.find(item => item.workspaceId === event.target.value)?.workspaceId) }}>
              <option value="">{t('defaultWorkspace')}</option>
              {workspaces.items.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
            </select>
          </label>
          <button ref={startTrigger} type="button" className={css.action}
            disabled={!connected || loading || starting}
            onClick={() => { start(selectedWorkspace, 'worktree') }}>{t(starting ? 'startingTask' : 'newTask')}</button>
        </div>
        <p className={css.notice}>{t('notice')}</p>
        {tasks === undefined && <p className={css.status}>{t('sessionActivityOnly')}</p>}
        {status !== undefined && <p role="status" className={css.status}>{status}</p>}
        {recovery !== undefined && <div ref={recoveryPanel} role="alert" tabIndex={-1} className={css.recovery}>
          <strong>{t('isolationFailed')}</strong>
          <p>{recovery.message}</p>
          <p className={css.warning}>{t('useDirectWarning')}</p>
          <div className={css.recoveryActions}>
            <button type="button" className={css.action}
              onClick={() => { start(recovery.workspaceId, 'worktree') }}>{t('retryIsolation')}</button>
            <button type="button" className={css.action}
              onClick={() => { start(recovery.workspaceId, 'direct') }}>{t('useDirect')}</button>
          </div>
        </div>}
        {recovery === undefined && (failure !== undefined || requestErrors.length > 0) &&
          <div role="alert" className={css.error}>{[failure, ...requestErrors].filter(Boolean).join('\n')}</div>}
        {synchronized && rowCount === 0 && <p className={css.empty}>{t('empty')}</p>}
        {(['needs-you', 'running', 'other'] as const).map((group) => {
          const groupedTasks = taskRows?.filter(row => row.group === group) ?? []
          const groupedActivity = activityRows?.filter(row => row.group === group) ?? []
          return (
            <section key={group} className={css.section} aria-labelledby={`tasks-${group}`}>
              <h2 id={`tasks-${group}`}>{t(`group.${group}`)}</h2>
              {synchronized && groupedTasks.length + groupedActivity.length === 0 &&
                <p className={css.empty}>{t(`empty.${group}`)}</p>}
              <ul className={css.list}>
                {groupedTasks.map(row => (
                  <li key={row.task.taskId} className={css.task}>
                    <button type="button" className={css.taskTitle} title={row.goal}
                      onClick={() => { open(row.task.taskId) }}>{row.goal}</button>
                    {row.task.executionWorkspace !== undefined
                      && ['reviewing', 'ready', 'settled'].includes(row.task.status)
                      && <button type="button" className={css.reviewAction}
                        onClick={() => { run(() => openReview(row.task.taskId)) }}>{t('reviewChanges')}</button>}
                    <div className={css.metadata}>
                      <span>{row.workspace?.title ?? t('unassigned')}</span>
                      {row.task.executionWorkspace !== undefined &&
                        <span className={css.worktree} title={row.task.executionWorkspace.path}>{t('worktree')}</span>}
                      <span>{t(`status.${row.task.status}`)}</span>
                      <span>{t('subagents', { n: row.activeDescendants })}</span>
                      <span>{t('criteria', row.criterionProgress)}</span>
                      <span>{t('risks', { n: row.unresolvedRiskCount })}</span>
                      <span>{t(`freshness.${row.task.freshness}`)}</span>
                    </div>
                    {row.attention.length > 0 && <ul className={css.pending}>
                      {row.attention.map(entry => (
                        <li key={entry.item.id}>
                          <button type="button" className={css.pendingAction}
                            onClick={() => { open(entry.item.ownerSessionId) }}>
                            {attentionOwnerTitle(entry, row.attention)} — {t(`attention.${entry.item.kind}`)}: {entry.item.summary}
                          </button>
                        </li>
                      ))}
                    </ul>}
                  </li>
                ))}
                {groupedActivity.map(row => (
                  <li key={row.root.id} className={css.task}>
                    <button type="button" className={css.taskTitle} title={row.root.displayTitle}
                      onClick={() => { open(row.root.id) }}>{row.root.displayTitle}</button>
                    <div className={css.metadata}>
                      <span>{row.workspace?.title ?? t('unassigned')}</span>
                      <span>{row.group === 'needs-you' ? t('group.needs-you') : t(row.group === 'running' ? 'running' : 'idle')}</span>
                      <span>{t('subagents', { n: row.runningDescendants })}</span>
                      {row.root.completed === true && <span>{t('unread')}</span>}
                    </div>
                    {row.pending.length > 0 && <ul className={css.pending}>
                      {row.pending.map(owner => (
                        <li key={owner.id}>
                          <button type="button" className={css.pendingAction} onClick={() => { open(owner.id) }}>
                            {pendingOwnerTitle(owner, row.pending)} — {t(owner.pendingInteraction)}
                          </button>
                        </li>
                      ))}
                    </ul>}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </main>
  )
}
