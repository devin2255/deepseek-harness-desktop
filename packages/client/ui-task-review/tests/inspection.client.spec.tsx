// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskDeliveryInspection } from '@deepseek-ai/dsh-api-remotes/client'
import { DeliveryInspection } from '../src/client/DeliveryInspection.tsx'
import type { TaskReviewProps } from '../src/client/TaskReview.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)
type TaskDeliveryIntent = TaskDeliveryInspection['intent']
const revision = 'a'.repeat(64) as TaskDeliveryIntent['reviewRevision']
const common = { operationId: '00000000-0000-4000-8000-000000000001' as TaskDeliveryIntent['operationId'], reviewRevision: revision }
const commit: TaskDeliveryIntent = { ...common, kind: 'commit', message: '<script>untrusted</script>', headCommit: '0'.repeat(40), tree: '2'.repeat(40) }
const apply: TaskDeliveryIntent = { ...common, kind: 'apply', commit: '1'.repeat(40), sourceHead: '0'.repeat(40) }
const discard: TaskDeliveryIntent = { ...common, kind: 'discard', confirmedUncommittedLoss: true, headCommit: '1'.repeat(40), uncommittedChanges: true }
const base = { taskId: 'root' as TaskDeliveryInspection['taskId'], workspaceId: 'workspace' as TaskDeliveryInspection['workspaceId'],
  revision: 'b'.repeat(64) as TaskDeliveryInspection['revision'], observedAt: 1_000 }
const t = ((key: keyof typeof en) => en[key]) as TaskReviewProps['t']

describe('Delivery inspection evidence', () => {
  it('renders absence as an observation, not proof that Git never ran', () => {
    const view = render(<DeliveryInspection inspection={{ ...base, intent: commit, status: 'not-completed' }} t={t} />)
    expect(view.getByRole('status').textContent).toContain(en.inspectionNotCompletedHelp)
    expect(view.getByText(commit.message)).toBeTruthy()
    expect(view.container.querySelector('script')).toBeNull()
    expect(view.getByText(en.observedAt)).toBeTruthy()
    expect(view.queryByRole('button')).toBeNull()
  })

  it.each(['task-changed', 'source-changed', 'discard-incomplete', 'state-changed'] as const)(
    'explains %s ambiguity without claiming completion', (reason) => {
      const view = render(<DeliveryInspection inspection={{ ...base, intent: commit, status: 'ambiguous', reason }} t={t} />)
      expect(view.getByRole('status').textContent).toContain(en[`inspection.${reason}`])
      expect(view.queryByText(en.inspectionCompleted)).toBeNull()
    },
  )

  it('shows exact Apply contents and source identities, not a saved Apply receipt', () => {
    const view = render(<DeliveryInspection inspection={{ ...base, intent: apply, status: 'completed', effect: {
      kind: 'apply', commit: apply.commit, sourceHead: apply.sourceHead, sourceTree: '3'.repeat(40),
    } }} t={t} />)
    expect(view.getByText(en.authorizedCommit)).toBeTruthy()
    expect(view.getByText(en.observedAppliedCommit)).toBeTruthy()
    expect(view.getByText('3'.repeat(40))).toBeTruthy()
    expect(view.queryByText(en.successApply)).toBeNull()
  })

  it.each([false, true])('shows discard recovery and uncommitted-loss facts (%s)', (dirty) => {
    const view = render(<DeliveryInspection inspection={{ ...base,
      intent: { ...discard, uncommittedChanges: dirty, confirmedUncommittedLoss: dirty }, status: 'completed', effect: {
        kind: 'discard', branch: 'dsh/task-root', headCommit: discard.headCommit, worktreeRemoved: true, branchPreserved: true,
        uncommittedChangesDiscarded: dirty, ...dirty ? { recoverableCommit: '4'.repeat(40) } : {},
      },
    }} t={t} />)
    expect(view.getByText('dsh/task-root')).toBeTruthy()
    expect(view.getByText(en.discardedDirty).nextElementSibling?.textContent).toBe(dirty ? en.yes : en.no)
    expect(view.getByText(en.authorizedLoss).nextElementSibling?.textContent).toBe(dirty ? en.yes : en.no)
    expect(view.queryByText('4'.repeat(40)) !== null).toBe(dirty)
    expect(view.queryByText(en.successDiscard)).toBeNull()
  })
})
