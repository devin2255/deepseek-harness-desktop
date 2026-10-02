/** Separate three-pane Task Review workspace over runtime-owned state. */
import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TaskReviewFile, TaskReviewState, TaskSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import type { TaskReviewInjected } from './index.ts'
import css from './TaskReview.module.css'

/** Runtime, locale, and business shares for the root Review occupant. */
export type TaskReviewProps = PropsRuntime<'shell.review'> & PropsLocale<'taskReview'> & InjectFace<TaskReviewInjected>

type Confirmation = 'changes' | 'commit' | 'apply' | 'discard'

/** Remove terminal control sequences and non-layout control characters from untrusted patch text. */
export function sanitizeDiffText(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 27 && value[index + 1] === '[') {
      index += 2
      while (index < value.length) {
        const terminal = value.charCodeAt(index)
        if (terminal >= 64 && terminal <= 126) break
        index += 1
      }
      continue
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue
    result += value.charAt(index)
  }
  return result
}

function changeText(file: TaskReviewFile, t: TaskReviewProps['t']): string {
  if (file.additions === null || file.deletions === null) return t('unknownChanges')
  return `${t('additions', { n: file.additions })} ${t('deletions', { n: file.deletions })}`
}

function isApplyConflict(state: TaskReviewState): boolean {
  return state.error?.code === 'task-review-rejected'
    && 'reviewCode' in state.error.details
    && state.error.details.reviewCode === 'REVIEW_APPLY_CONFLICT'
}

function successKey(task: TaskSnapshot | null): 'successCommit' | 'successApply' | 'successDiscard' | 'successChanges' | undefined {
  if (task?.discardReceipt !== undefined) return 'successDiscard'
  if (task?.applyReceipt !== undefined) return 'successApply'
  if (task?.commitReceipt !== undefined) return 'successCommit'
  if (task?.reviewDecision === 'changes-requested') return 'successChanges'
  return undefined
}

/** Full review workspace with file navigation, patch, evidence, and explicit delivery actions. */
export function TaskReview({
  useTasks, useTaskReview, showTasks, refresh, selectFile,
  requestChanges, commit, apply, discard, t,
}: TaskReviewProps) {
  const review = useTaskReview(value => value)
  const taskState = useTasks?.(value => value)
  const task = review.taskId === undefined
    ? review.result
    : taskState?.byId[review.taskId] ?? review.result
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [commitMessage, setCommitMessage] = useState('')
  const dialog = useRef<HTMLDivElement>(null)
  useEffect(() => { dialog.current?.focus() }, [confirmation])
  const evidence = useMemo(
    () => task?.definition?.criteria.flatMap(criterion => criterion.evidence.map(item => ({ criterion: criterion.text, ...item }))) ?? [],
    [task],
  )
  const summary = review.summary
  const busy = review.operation !== null
  const fresh = review.freshness === 'fresh'
  const canRequest = fresh && !busy && (task?.status === 'reviewing' || task?.status === 'ready')
  const canCommit = fresh && !busy && task?.reviewDecision === 'ready'
    && task.commitReceipt === undefined && summary?.dirty === true
  const canApply = fresh && !busy && task?.commitReceipt !== undefined
    && task.applyReceipt === undefined && task.discardReceipt === undefined
  const canDiscard = fresh && !busy && task?.applyReceipt === undefined && task?.discardReceipt === undefined
  const visibleResult = review.result ?? task ?? null
  const success = successKey(visibleResult)

  const runConfirmed = (): void => {
    const action = confirmation
    if (action === undefined || task == null) return
    setConfirmation(undefined)
    if (action === 'changes') void requestChanges(task.asOfSeq)
    else if (action === 'commit') void commit(commitMessage.trim(), task.asOfSeq)
    else if (action === 'apply' && task.commitReceipt !== undefined) void apply(task.commitReceipt.commit, task.asOfSeq)
    else if (action === 'discard' && summary !== null) void discard(summary.dirty, task.asOfSeq)
  }

  return (
    <main className={css.root} aria-label={t('review')}>
      <header className={css.header}>
        <div className={css.titleBlock}>
          <button type="button" className={css.back} onClick={showTasks}>← {t('back')}</button>
          <h1>{task?.definition?.goal ?? t('review')}</h1>
          {summary !== null && <div className={css.facts}>
            <span>{t('branch')}: <code>{summary.branch}</code></span>
            <span>{t('base')}: <code>{summary.baseCommit.slice(0, 10)}</code></span>
            <span>{t('head')}: <code>{summary.headCommit.slice(0, 10)}</code></span>
            <span>{t('sourceHead')}: <code>{summary.sourceHead.slice(0, 10)}</code></span>
          </div>}
        </div>
        <button type="button" className={css.secondary} disabled={review.state === 'loading'} onClick={() => { void refresh() }}>{t('refresh')}</button>
      </header>

      {review.freshness === 'stale' && <div role="status" className={css.stale}>{t('stale')}</div>}
      {review.state === 'loading' && summary === null && <div role="status" className={css.centerState}>{t('loading')}</div>}
      {review.error !== null && <div role="alert" className={clsx(css.alert, isApplyConflict(review) && css.conflict)}>
        <strong>{isApplyConflict(review) ? t('conflict') : t('error')}</strong>
        {!isApplyConflict(review) && <span>{review.error.message}</span>}
        <button type="button" className={css.secondary} onClick={() => { void refresh() }}>{t('retry')}</button>
      </div>}
      {success !== undefined && <div role="status" className={css.success}>
        <strong>{t(success)}</strong>
        {visibleResult?.discardReceipt?.branchPreserved === true && <span>{t('preservedBranch')}: <code>{visibleResult.discardReceipt.branch}</code></span>}
        {visibleResult?.discardReceipt?.recoverableCommit !== undefined && <span>{t('recoverableCommit')}: <code>{visibleResult.discardReceipt.recoverableCommit}</code></span>}
      </div>}
      {summary?.truncated === true && <div role="status" className={css.warning}>{t('truncated')}</div>}
      {summary?.sourceDirty === true && <div role="status" className={css.warning}>{t('sourceDirty')}</div>}

      {review.state !== 'loading' && summary !== null && summary.files.length === 0
        ? <div className={css.centerState}>{t('empty')}</div>
        : summary !== null && <div className={css.workspace}>
          <nav className={css.files} aria-label={t('files')}>
            <h2>{t('files')}</h2>
            <div className={css.totals}><span>{t('additions', { n: summary.additions })}</span><span>{t('deletions', { n: summary.deletions })}</span></div>
            <ul>
              {summary.files.map(file => <li key={file.path}>
                <button type="button" aria-current={review.selectedPath === file.path ? 'true' : undefined}
                  onClick={() => { void selectFile(file.path) }}>
                  <span className={css.path}>{file.path}</span>
                  {file.previousPath !== undefined && <span className={css.previous}>{file.previousPath} →</span>}
                  <span className={css.fileMeta}>{t('fileStatus', {
                    status: t(`file.${file.status}`), change: changeText(file, t),
                  })}</span>
                </button>
              </li>)}
            </ul>
          </nav>

          <section className={css.diff} aria-labelledby="task-review-diff">
            <h2 id="task-review-diff">{t('diff')}</h2>
            {review.diffState === 'loading' && <p role="status">{t('diffLoading')}</p>}
            {review.diffState === 'idle' && <p>{t('noDiff')}</p>}
            {review.diff?.binary === true && <p className={css.warning}>{t('binary')}</p>}
            {review.diff?.truncated === true && <p className={css.warning}>{t('truncated')}</p>}
            {review.diff !== null && !review.diff.binary && <pre aria-label={review.diff.path}>{sanitizeDiffText(review.diff.patch).split('\n').map((line, index) => (
              <span key={`${index}-${line.slice(0, 16)}`} className={clsx(
                line.startsWith('+') && !line.startsWith('+++') && css.added,
                line.startsWith('-') && !line.startsWith('---') && css.deleted,
                line.startsWith('@@') && css.hunk,
              )}>{line}{'\n'}</span>
            ))}</pre>}
          </section>

          <aside className={css.inspector} aria-label={t('inspector')}>
            <section><h2>{t('criteria')}</h2>
              {task?.definition?.criteria.length ? <ul>{task.definition.criteria.map(criterion => <li key={criterion.id}>
                <span className={css.badge}>{t(`criterion.${criterion.status}`)}</span> {criterion.text}
              </li>)}</ul> : <p>{t('noCriteria')}</p>}
            </section>
            <section><h2>{t('evidence')}</h2>
              {evidence.length > 0 ? <ul>{evidence.map(item => <li key={`${item.sessionId}:${item.seq}`}>
                <span>{item.criterion}</span><code>{item.sessionId} · #{item.seq}</code>
              </li>)}</ul> : <p>{t('noEvidence')}</p>}
            </section>
            <section><h2>{t('risks')}</h2>
              {task?.risks.length ? <ul>{task.risks.map(risk => <li key={risk.id}>
                <span className={clsx(css.badge, (risk.severity === 'high' || risk.severity === 'critical') && css.high)}>{t(`risk.${risk.severity}`)}</span> {risk.summary}
              </li>)}</ul> : <p>{t('noRisks')}</p>}
            </section>
          </aside>
        </div>}

      <footer className={css.actions}>
        <button type="button" className={css.secondary} disabled={!canRequest} onClick={() => { setConfirmation('changes') }}>{t('requestChanges')}</button>
        <label className={css.commitField}>{t('commitMessage')}<input value={commitMessage} placeholder={t('commitPlaceholder')}
          onChange={(event) => { setCommitMessage(event.target.value) }} /></label>
        <button type="button" className={css.primary} disabled={!canCommit || commitMessage.trim() === ''}
          onClick={() => { setConfirmation('commit') }}>{t('commit')}</button>
        <button type="button" className={css.primary} disabled={!canApply} onClick={() => { setConfirmation('apply') }}>{t('apply')}</button>
        <button type="button" className={css.danger} disabled={!canDiscard} onClick={() => { setConfirmation('discard') }}>{t('discard')}</button>
        {busy && <span role="status">{t('busy')}</span>}
      </footer>

      {confirmation !== undefined && <div className={css.scrim}>
        <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="task-review-confirm" tabIndex={-1} className={css.dialog}>
          <h2 id="task-review-confirm">{t(confirmation === 'changes' ? 'requestChanges' : confirmation)}</h2>
          <p>{t(confirmation === 'changes' ? 'confirmChanges'
            : confirmation === 'commit' ? 'confirmCommit'
              : confirmation === 'apply' ? 'confirmApply'
                : summary?.dirty === true ? 'confirmDiscardDirty' : 'confirmDiscardClean')}</p>
          <div>
            <button type="button" className={css.secondary} onClick={() => { setConfirmation(undefined) }}>{t('close')}</button>
            <button type="button" className={confirmation === 'discard' ? css.danger : css.primary} onClick={runConfirmed}>{t('confirm')}</button>
          </div>
        </div>
      </div>}
    </main>
  )
}
