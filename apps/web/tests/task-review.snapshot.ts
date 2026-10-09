// @vitest-environment jsdom
/** Keyless built-plugin acceptance for the Task review and delivery workspace. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

function rowFor(label: string): HTMLElement {
  const row = screen.getByRole('button', { name: label }).closest('li')
  if (row === null) throw new Error(`Task row has no list item: ${label}`)
  return row
}

it('reviews separate tasks and displays durable request, commit, and apply outcomes', async () => {
  mountAssembledApp({ taskReview: true })
  const overview = await screen.findByRole('main', { name: 'Tasks' }, { timeout: 10_000 })

  fireEvent.click(within(rowFor('Fixture request changes')).getByRole('button', { name: 'Review changes' }))
  let review = await screen.findByRole('main', { name: 'Change Review' })
  expect(review.textContent).toContain('dsh/task-fixture-request')
  expect(within(review).getByLabelText('src/request.ts').textContent).toContain('+requested = false')
  fireEvent.click(within(review).getByRole('button', { name: 'Request Changes' }))
  fireEvent.click(within(review).getByRole('button', { name: 'Confirm' }))
  await within(review).findByText('Changes were requested from the Agent.')

  fireEvent.click(within(review).getByRole('button', { name: /Back to Tasks/ }))
  await screen.findByRole('main', { name: 'Tasks' })
  fireEvent.click(within(rowFor('Fixture review delivery')).getByRole('button', { name: 'Review changes' }))
  review = await screen.findByRole('main', { name: 'Change Review' })
  const integrations = within(review).getByRole('region', { name: 'Agent result integration' })
  expect(integrations.textContent).toContain('Preflight conflict')
  expect(integrations.textContent).toContain('Later integrations cover every contributor')
  expect(integrations.textContent).toContain('Merged into root task')
  expect(integrations.textContent).toContain('Merging into the root does not apply changes to the project.')
  fireEvent.click(within(review).getByRole('button', { name: /assets\/fixture\.png/ }))
  await within(review).findByText('Binary files have no text diff to display.')
  fireEvent.click(within(review).getByRole('button', { name: /src\/delivery\.ts/ }))
  await waitFor(() => {
    expect(within(review).getByLabelText('src/delivery.ts').textContent).toContain('+delivered = true')
  })
  fireEvent.change(within(review).getByLabelText('Commit message'), { target: { value: 'feat: deliver fixture' } })
  fireEvent.click(within(review).getByRole('button', { name: 'Create Commit' }))
  fireEvent.click(within(review).getByRole('button', { name: 'Confirm' }))
  await within(review).findByText('Task changes were committed.')
  fireEvent.click(within(review).getByRole('button', { name: 'Apply to Project' }))
  fireEvent.click(within(review).getByRole('button', { name: 'Confirm' }))
  await within(review).findByText('The task commit was safely applied to the project.')

  fireEvent.click(within(review).getByRole('button', { name: /Back to Tasks/ }))
  const returned = await screen.findByRole('main', { name: 'Tasks' })
  expect(within(rowFor('Fixture review delivery')).getByText('Settled')).toBeTruthy()
  expect(returned).toBe(overview)
})
