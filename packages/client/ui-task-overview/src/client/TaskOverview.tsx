/** Desktop task overview over framework-provided runtime metadata. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { OverviewInjected } from './index.ts'
import { selectTasks, type TaskRow } from './select-tasks.ts'
import css from './TaskOverview.module.css'

/** Runtime, locale and injected shares; no business-state store. */
export type TaskOverviewProps = PropsRuntime<'shell.home'> & PropsLocale<'taskOverview'> & InjectFace<OverviewInjected>

function pendingOwnerTitle(owner: TaskRow['pending'][number], pending: TaskRow['pending']): string {
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

/** Overview page with task groups and metadata health. */
export function TaskOverview({ useSessions, useWorkspaces, useHostDescription, openTask, startTask, refresh, t }: TaskOverviewProps) {
  const sessions = useSessions(value => value)
  const workspaces = useWorkspaces(value => value)
  const connected = useHostDescription(value => value !== undefined)
  const rows = useMemo(() => selectTasks(sessions, workspaces), [sessions, workspaces])
  const [workspaceId, setWorkspaceId] = useState<WorkspaceId | undefined>()
  const [failure, setFailure] = useState<string>()
  const attempt = useRef(0)
  useEffect(() => () => { attempt.current += 1 }, [])
  const run = (action: () => void | Promise<void>): void => {
    const current = ++attempt.current
    setFailure(undefined)
    void Promise.resolve().then(action).catch((error: unknown) => {
      if (current === attempt.current) setFailure(error instanceof Error ? error.message : String(error))
    })
  }
  const open = (id: SessionId): void => { run(() => openTask(id)) }
  const initial = sessions.phase === 'pending' || workspaces.phase === 'pending'
  const loading = sessions.state === 'loading' || workspaces.state === 'loading'
  const failed = sessions.state === 'error' || workspaces.state === 'error'
  const synchronized = connected && !initial && !loading && !failed
  const selectedWorkspace = workspaces.items.find(item => item.workspaceId === workspaceId)?.workspaceId
  const requestErrors = [sessions.error?.message, workspaces.error?.message].filter(message => message !== undefined)
  const status = !connected ? t(initial ? 'loading' : 'disconnected')
    : failed ? t('failed') : initial ? t('loading') : loading ? t('refreshing') : undefined

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
            <select className={css.control} value={selectedWorkspace ?? ''} disabled={!connected || loading}
              onChange={(event) => { setWorkspaceId(workspaces.items.find(item => item.workspaceId === event.target.value)?.workspaceId) }}>
              <option value="">{t('defaultWorkspace')}</option>
              {workspaces.items.map(item => <option key={item.workspaceId} value={item.workspaceId}>{item.title}</option>)}
            </select>
          </label>
          <button type="button" className={css.action} disabled={!connected || loading}
            onClick={() => {
              setFailure(undefined)
              try { startTask(selectedWorkspace) }
              catch (error) { setFailure(error instanceof Error ? error.message : String(error)) }
            }}>{t('newTask')}</button>
        </div>
        <p className={css.notice}>{t('notice')}</p>
        {status !== undefined && <p role="status" className={css.status}>{status}</p>}
        {(failure !== undefined || requestErrors.length > 0) &&
          <div role="alert" className={css.error}>{[failure, ...requestErrors].filter(Boolean).join('\n')}</div>}
        {synchronized && rows.length === 0 && <p className={css.empty}>{t('empty')}</p>}
        {(['needs-you', 'running', 'other'] as const).map((group) => {
          const grouped = rows.filter(row => row.group === group)
          return (
            <section key={group} className={css.section} aria-labelledby={`tasks-${group}`}>
              <h2 id={`tasks-${group}`}>{t(`group.${group}`)}</h2>
              {synchronized && grouped.length === 0 && <p className={css.empty}>{t(`empty.${group}`)}</p>}
              <ul className={css.list}>
                {grouped.map(row => (
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
