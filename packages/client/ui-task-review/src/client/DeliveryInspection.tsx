/** Point-in-time Git evidence, distinct from durable execution receipts. */
import type { TaskDeliveryInspection } from '@deepseek-ai/dsh-api-remotes/client'
import type { TaskReviewProps } from './TaskReview.tsx'
import css from './TaskReview.module.css'

/* v8 ignore next -- the wire parser validates closed inspection unions before the typed component receives them. */
function assertNever(value: never): never {
  throw new Error(`Unknown delivery observation: ${String(value)}`)
}

function outcome(inspection: TaskDeliveryInspection, t: TaskReviewProps['t']) {
  switch (inspection.status) {
    case 'completed': return <><strong>{t('inspectionCompleted')}</strong><p>{t('inspectionCompletedHelp')}</p></>
    case 'not-completed': return <><strong>{t('inspectionNotCompleted')}</strong><p>{t('inspectionNotCompletedHelp')}</p></>
    case 'ambiguous': return <><strong>{t('inspectionAmbiguous')}</strong><p>{t(`inspection.${inspection.reason}`)}</p></>
    /* v8 ignore next -- every validated inspection status is handled above. */
    default: return assertNever(inspection)
  }
}

/**
 * Render authoritative observation fields without inferring execution time or permitting mutations.
 * @param props - Host evidence and localized copy.
 * @returns Read-only evidence panel.
 */
export function DeliveryInspection({ inspection, t }: { inspection: TaskDeliveryInspection; t: TaskReviewProps['t'] }) {
  const observedAt = new Date(inspection.observedAt).toISOString()
  const intent = inspection.intent
  return <section className={css.inspection} aria-label={t('deliveryEvidence')}>
    <h2>{t('deliveryEvidence')}</h2>
    <div role="status">{outcome(inspection, t)}</div>
    <p>{t('inspectionHelp')}</p>
    <dl>
      <dt>{t('observedAt')}</dt><dd><time dateTime={observedAt}>{observedAt}</time></dd>
      <dt>{t('authorizedAction')}</dt><dd>{t(intent.kind)}</dd>
      <dt>{t('authorizedRevision')}</dt><dd><code>{intent.reviewRevision}</code></dd>
      <IntentEvidence intent={intent} t={t} />
    </dl>
    {inspection.status === 'completed' && <EffectEvidence inspection={inspection} t={t} />}
  </section>
}

function IntentEvidence({ intent, t }: { intent: TaskDeliveryInspection['intent']; t: TaskReviewProps['t'] }) {
  switch (intent.kind) {
    case 'commit': return <>
      <dt>{t('commitMessage')}</dt><dd>{intent.message}</dd>
      <dt>{t('authorizedHead')}</dt><dd><code>{intent.headCommit}</code></dd>
      <dt>{t('authorizedTree')}</dt><dd><code>{intent.tree}</code></dd>
    </>
    case 'apply': return <>
      <dt>{t('authorizedCommit')}</dt><dd><code>{intent.commit}</code></dd>
      <dt>{t('sourceHead')}</dt><dd><code>{intent.sourceHead}</code></dd>
    </>
    case 'discard': return <>
      <dt>{t('authorizedHead')}</dt><dd><code>{intent.headCommit}</code></dd>
      <dt>{t('authorizedDirty')}</dt><dd>{t(intent.uncommittedChanges ? 'yes' : 'no')}</dd>
      <dt>{t('authorizedLoss')}</dt><dd>{t(intent.confirmedUncommittedLoss ? 'yes' : 'no')}</dd>
    </>
    /* v8 ignore next -- every validated authorization kind is handled above. */
    default: return assertNever(intent)
  }
}

function EffectEvidence({ inspection, t }: {
  inspection: Extract<TaskDeliveryInspection, { status: 'completed' }>
  t: TaskReviewProps['t']
}) {
  const effect = inspection.effect
  switch (effect.kind) {
    case 'commit': return <dl>
      <dt>{t('observedCommit')}</dt><dd><code>{effect.commit}</code></dd>
      <dt>{t('observedParent')}</dt><dd><code>{effect.headBefore}</code></dd>
      <dt>{t('observedTree')}</dt><dd><code>{effect.tree}</code></dd>
      <dt>{t('branch')}</dt><dd><code>{effect.branch}</code></dd>
      <dt>{t('observedRevision')}</dt><dd><code>{effect.committedRevision}</code></dd>
    </dl>
    case 'apply': return <dl>
      <dt>{t('observedAppliedCommit')}</dt><dd><code>{effect.commit}</code></dd>
      <dt>{t('sourceHead')}</dt><dd><code>{effect.sourceHead}</code></dd>
      <dt>{t('observedSourceTree')}</dt><dd><code>{effect.sourceTree}</code></dd>
    </dl>
    case 'discard': return <dl>
      <dt>{t('removed')}</dt><dd>{t('yes')}</dd>
      <dt>{t('preservedBranch')}</dt><dd><code>{effect.branch}</code></dd>
      <dt>{t('head')}</dt><dd><code>{effect.headCommit}</code></dd>
      <dt>{t('discardedDirty')}</dt><dd>{t(effect.uncommittedChangesDiscarded ? 'yes' : 'no')}</dd>
      {effect.recoverableCommit !== undefined && <>
        <dt>{t('recoverableCommit')}</dt><dd><code>{effect.recoverableCommit}</code></dd>
      </>}
    </dl>
    /* v8 ignore next -- every validated completed-effect kind is handled above. */
    default: return assertNever(effect)
  }
}
