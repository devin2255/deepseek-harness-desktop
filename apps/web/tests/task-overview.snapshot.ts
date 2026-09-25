// @vitest-environment jsdom
/** Keyless built-plugin navigation journey with the desktop-only overview opt-in. */
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installAssembledBootEnv, mountAssembledApp, REFRESHING_GOLDEN } from './assembled-boot.ts'

installAssembledBootEnv()

it('keeps a root draft while routing known descendant attention through the desktop overview', async () => {
  mountAssembledApp({ taskOverview: true })
  const overview = await screen.findByRole('main', { name: 'Tasks' }, { timeout: 10_000 })
  await within(overview).findByRole('button', { name: 'Fixture 历史会话' })
  const childAttention = await within(overview).findByRole('button', { name: /^fixture — Question:/ })
  expect(within(overview).getAllByRole('heading').map(node => node.textContent)).toEqual(['Tasks', 'Needs You', 'Running', 'Other'])
  expect(overview.textContent).toContain('New tasks run in isolated Git worktrees by default')
  const projection = [...overview.querySelectorAll('section')].map(section => ({
    group: section.querySelector('h2')?.textContent,
    tasks: [...section.querySelectorAll(':scope > ul > li')].map(row => row.textContent),
  }))
  const golden = join(process.cwd(), 'apps/web/tests/snapshots/task-overview/groups.expected.json')
  const output = `${JSON.stringify(projection, null, 2)}\n`
  if (REFRESHING_GOLDEN) {
    mkdirSync(dirname(golden), { recursive: true })
    writeFileSync(golden, output)
  }
  expect(output).toBe(readFileSync(golden, 'utf8'))
  const other = [...overview.querySelectorAll('section')].find(section => section.querySelector('h2')?.textContent === 'Other')
  if (other === undefined) throw new Error('Other task group was not rendered')
  const draftRoot = within(other).getAllByRole('button')[0]
  if (draftRoot === undefined) throw new Error('Other task root was not rendered')
  fireEvent.click(draftRoot)
  await waitFor(() => { expect(screen.queryByRole('main', { name: 'Tasks' })).toBeNull() })
  const composer = await screen.findByPlaceholderText('Message the agent')
  fireEvent.change(composer, { target: { value: 'draft retained across overview navigation' } })
  fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
  const returned = await screen.findByRole('main', { name: 'Tasks' })
  expect(returned).toBe(overview)
  fireEvent.click(draftRoot)
  expect((await screen.findByPlaceholderText<HTMLInputElement>('Message the agent')).value)
    .toBe('draft retained across overview navigation')
  fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
  await screen.findByRole('main', { name: 'Tasks' })
  fireEvent.click(childAttention)
  await screen.findByText('你现在更想招哪类 Agent/Harness 候选人？')
  expect(screen.queryByRole('main', { name: 'Tasks' })).toBeNull()
})

it('leaves ordinary Web composition without a Tasks navigation entry', async () => {
  mountAssembledApp()
  await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull()
  expect(screen.queryByRole('main', { name: 'Tasks' })).toBeNull()
})

it('hides a root Task after archiving its Session through the assembled sidebar', async () => {
  mountAssembledApp({ taskOverview: true })
  const overview = await screen.findByRole('main', { name: 'Tasks' }, { timeout: 10_000 })
  await within(overview).findByRole('button', { name: 'Fixture 历史会话' })
  const row = screen.getByRole('treeitem', { name: /Fixture 历史会话/u })
  const actions = row.querySelector<HTMLButtonElement>('button[aria-label="Session actions for Fixture 历史会话"]')
  if (actions === null) throw new Error('fixture root is missing its archive menu')
  fireEvent.click(actions)
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Archive session' }))
  await waitFor(() => {
    expect(within(overview).queryByRole('button', { name: 'Fixture 历史会话' })).toBeNull()
  })
  const projection = [...overview.querySelectorAll('section')].map(section => ({
    group: section.querySelector('h2')?.textContent,
    tasks: [...section.querySelectorAll(':scope > ul > li')].map(row => row.textContent),
  }))
  const golden = join(process.cwd(), 'apps/web/tests/snapshots/task-overview/archived.expected.json')
  const output = `${JSON.stringify(projection, null, 2)}\n`
  if (REFRESHING_GOLDEN) {
    mkdirSync(dirname(golden), { recursive: true })
    writeFileSync(golden, output)
  }
  expect(output).toBe(readFileSync(golden, 'utf8'))
})

it('creates an isolated task through the assembled desktop roster', async () => {
  mountAssembledApp({ taskOverview: true })
  const overview = await screen.findByRole('main', { name: 'Tasks' }, { timeout: 10_000 })
  expect(overview.textContent).toContain('New tasks run in isolated Git worktrees by default')
  fireEvent.click(within(overview).getByRole('button', { name: 'New Task' }))
  await waitFor(() => { expect(screen.queryByRole('main', { name: 'Tasks' })).toBeNull() })
  fireEvent.click(await screen.findByRole('button', { name: 'Tasks' }))
  const returned = await screen.findByRole('main', { name: 'Tasks' })
  fireEvent.click(within(returned).getByRole('button', { name: 'Refresh' }))
  const created = await within(returned).findByRole('button', { name: 'Fixture isolated task 1' })
  const row = created.closest('li')
  if (row === null) throw new Error('isolated fixture Task row has no list item')
  expect(row.textContent).toContain('fixture')
  expect(row.textContent).toContain('Worktree')
  expect(within(row).getByTitle(/^\/tmp\/fixture-worktrees\/fx-\d+$/u).textContent).toBe('Worktree')
})
