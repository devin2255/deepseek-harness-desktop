/** Catalog navigation uses the real runtime; only the wire client is scripted. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SessionRuntime, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { FakeApiClient, fakeRemote, ok } from '../../runtime/tests/fake-api.client.ts'
import { createTaskNavigation } from '../src/client/navigation.ts'

it('opens a never-selected child from its fetched direct-parent catalog', async () => {
  const parent = 'parent' as SessionId
  const child = 'child' as SessionId
  const api = new FakeApiClient()
  api.onList = async () => ok({ items: [
    { sessionId: parent, blank: false, running: false, updatedAt: 1 },
    { sessionId: child, parentSessionId: parent, origin: 'subagent', blank: false, running: true, updatedAt: 1 },
  ] as never[] })
  api.onSubagentList = async payload => ok({
    parentAvailable: true,
    entries: (payload as { parentSessionId: SessionId }).parentSessionId === parent
      ? [{ kind: 'child', id: child, mode: 'continuable', label: 'Worker', activity: 'running', hasChildren: false }] as never[]
      : [],
  })
  const sessions = new SessionRuntime(new Context(), api, fakeRemote())
  await sessions.refresh()
  expect(sessions.subagentAddress(child)).toBeUndefined()
  const showConversation = vi.fn()
  const navigation = createTaskNavigation(sessions, { showConversation })
  await navigation.open(child)
  expect(sessions.list.getSnapshot().currentAddress).toEqual({
    parentSessionId: parent, childSessionId: child, mode: 'continuable',
  })
  expect(showConversation).toHaveBeenCalledOnce()
  navigation.dispose()
})
