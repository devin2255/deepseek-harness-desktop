/** Persistent Tasks navigation in the sidebar footer. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './index.ts'
import clsx from 'clsx'
import css from './TaskOverview.module.css'

type TasksActionProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<'taskOverview'> & { showHome: () => void }

/** Wide label or compact accessible rail control. */
export function TasksAction({ wide, showHome, t }: TasksActionProps) {
  return (
    <button type="button" className={clsx(css.action, css.footer, !wide && css.compact)}
      aria-label={t('tasks')} title={t('tasks')} onClick={showHome}>
      <svg className={css.icon} viewBox="0 0 20 20" fill="none" stroke="currentColor" aria-hidden="true">
        <rect x="2" y="3" width="5" height="5" rx="1" />
        <rect x="2" y="12" width="5" height="5" rx="1" />
        <path d="M10 5h8M10 8h5M10 14h8M10 17h5" />
      </svg>
      {wide && <span>{t('tasks')}</span>}
    </button>
  )
}
