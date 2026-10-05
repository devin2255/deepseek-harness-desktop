/** Read-only inspection of the selected Session's recorded request facts. */
import { useEffect, useState } from 'react'
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
import type { RequestView } from '@deepseek-ai/dsh-client-runtime/client'
import type { ITrajectory } from '@deepseek-ai/dsh-client-ui-trajectory/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { StudioKey } from './locales.ts'
import css from './HarnessStudio.module.css'

/** Data and navigation granted by the registration. */
export interface StudioInjected {
  listPlugins: () => Promise<PluginInventorySnapshot>
  inspect: ITrajectory['inspect']
  back: () => void
}

/** Full Studio props from the slot, locale, and registration. */
export type HarnessStudioProps = PropsRuntime<'shell.studio'> & PropsLocale<'studio'> & InjectFace<StudioInjected>

type PluginState =
  | { readonly status: 'idle' | 'loading' | 'error' }
  | { readonly status: 'ready'; readonly snapshot: PluginInventorySnapshot }

/** Latest ordinary request with an actual logged header, not a guessed current setting. */
export function latestRecordedRequest(requests: readonly RequestView[]): Extract<RequestView, { purpose: 'assistant' }> | undefined {
  for (let index = requests.length - 1; index >= 0; index--) {
    const request = requests[index]
    if (request?.purpose === 'assistant' && request.prompt !== undefined) return request
  }
  return undefined
}

/** The task-focused Studio page; current Host inventory is explicitly separate. */
export function HarnessStudio({ active, sessionId, useSession, useSessions, listPlugins, inspect, back, t }: HarnessStudioProps) {
  const summary = useSessions(state => sessionId === undefined ? undefined : state.byId[sessionId])
  const trajectory = useSession(snapshot => inspect(snapshot))
  const [plugins, setPlugins] = useState<PluginState>({ status: 'idle' })
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!active || sessionId === undefined) return
    let live = true
    setPlugins({ status: 'loading' })
    void listPlugins().then(
      (snapshot) => { if (live) setPlugins({ status: 'ready', snapshot }) },
      () => { if (live) setPlugins({ status: 'error' }) },
    )
    return () => { live = false }
  }, [active, listPlugins, revision, sessionId])

  const request = latestRecordedRequest(trajectory?.requests ?? [])
  const config = request?.prompt?.config
  const tools = request?.prompt?.tools ?? []
  const events = trajectory?.eventNodes.slice(-12) ?? []
  const phaseKey = (phase: NonNullable<PluginInventorySnapshot['entries'][number]['fiberPhase']>): StudioKey => phase

  return <main className={css.root} aria-label={t('title')}>
    <div className={css.content}>
      <header className={css.header}>
        <div><p className={css.eyebrow}>DEEPSEEK HARNESS</p><h1>{t('title')}</h1>
          {summary !== undefined && <p className={css.subtitle}>{summary.displayTitle}</p>}</div>
        <button type="button" className={css.button} onClick={back}>{t('back')}</button>
      </header>
      {sessionId === undefined ? <p className={css.empty}>{t('noTask')}</p> : <>
        <section className={css.section} aria-labelledby="studio-recorded">
          <h2 id="studio-recorded">{t('recorded')}</h2>
          <dl className={css.facts}>
            <div><dt>{t('preset')}</dt><dd><code>{summary?.agentPreset ?? t('noPreset')}</code></dd></div>
            <div><dt>{t('model')}</dt><dd>{config === undefined ? t('noRequest') : <code>{config.provider} / {config.model}</code>}</dd></div>
            {request !== undefined && <div><dt>{t('requestStatus')}</dt><dd>{request.status}</dd></div>}
          </dl>
        </section>
        <section className={css.section} aria-labelledby="studio-tools">
          <h2 id="studio-tools">{t('tools')} <span className={css.count}>{tools.length}</span></h2>
          {tools.length === 0 ? <p className={css.empty}>{t('noTools')}</p> :
            <ul className={css.toolList}>{tools.map(tool => <li key={tool.name}>
              <strong>{tool.name}</strong><span>{tool.description}</span>
            </li>)}</ul>}
        </section>
        <section className={css.section} aria-labelledby="studio-system">
          <h2 id="studio-system">{t('system')}</h2>
          {request?.prompt?.system ? <pre className={css.system}>{request.prompt.system}</pre> : <p className={css.empty}>{t('noSystem')}</p>}
        </section>
        <section className={css.section} aria-labelledby="studio-events">
          <h2 id="studio-events">{t('events')}</h2>
          {events.length === 0 ? <p className={css.empty}>{t('noEvents')}</p> :
            <ol className={css.events}>{events.map(event => <li key={event.seq}>
              <code>#{event.seq}</code><span>{event.kind}</span>
              <time dateTime={new Date(event.time).toISOString()}>{new Date(event.time).toLocaleString()}</time>
            </li>)}</ol>}
          <p className={css.hint}>{t('partial')}</p>
        </section>
        <section className={css.section} aria-labelledby="studio-host">
          <h2 id="studio-host">{t('currentHost')}</h2>
          <p className={css.hint}>{t('currentHostHint')}</p>
          {plugins.status === 'loading' && <p role="status">{t('pluginsLoading')}</p>}
          {plugins.status === 'error' && <p role="alert">{t('pluginsError')} <button type="button" className={css.button} onClick={() => { setRevision(value => value + 1) }}>{t('retry')}</button></p>}
          {plugins.status === 'ready' && (plugins.snapshot.entries.length === 0
            ? <p className={css.empty}>{t('noPlugins')}</p>
            : <ul className={css.plugins}>{plugins.snapshot.entries.map(entry => <li key={entry.entryId}>
              <code>{entry.moduleName}</code><span>{t(entry.enabled ? 'enabled' : 'disabled')}</span>
              {entry.enabled && <span>{t(entry.fiberPhase === null ? 'unobserved' : phaseKey(entry.fiberPhase))}</span>}
            </li>)}</ul>)}
        </section>
        <section className={css.section} aria-labelledby="studio-unrecorded">
          <h2 id="studio-unrecorded">{t('incomplete')}</h2><p className={css.hint}>{t('incompleteHint')}</p>
        </section>
      </>}
    </div>
  </main>
}
