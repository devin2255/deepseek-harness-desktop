import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionId, SubagentAddress } from '@deepseek-ai/dsh-client-runtime/client'
import { createTaskNavigation } from '../src/client/navigation.ts'

const id = (value: string) => value as SessionId
function bench() {
  let address: SubagentAddress | undefined
  const sessions = {
    list: { getSnapshot: () => ({ byId: { child: { id: id('child'), origin: 'subagent', parentId: id('parent') }, root: { id: id('root') } }, subagentsByParent: {} }) },
    open: vi.fn(), openSubagent: vi.fn(), subagentAddress: vi.fn(() => address), refreshSubagents: vi.fn(async () => {}),
  }
  const showConversation = vi.fn()
  return {
    sessions, showConversation, navigation: createTaskNavigation(sessions as unknown as ISessions, { showConversation }),
    setAddress: (next: SubagentAddress) => { address = next },
  }
}

describe('task navigation', () => {
  it('opens an ordinary root and reveals even an already selected conversation', async () => {
    const b = bench()
    await b.navigation.open(id('root'))
    await b.navigation.open(id('root'))
    expect(b.sessions.open).toHaveBeenCalledTimes(2)
    expect(b.showConversation).toHaveBeenCalledTimes(2)
  })
  it('refreshes only the direct parent then uses the authoritative returned address', async () => {
    const b = bench()
    const address: SubagentAddress = { parentSessionId: id('parent'), childSessionId: id('child'), mode: 'one-shot' }
    b.sessions.refreshSubagents.mockImplementationOnce(async () => { b.setAddress(address) })
    await b.navigation.open(id('child'))
    expect(b.sessions.refreshSubagents).toHaveBeenCalledWith('parent')
    expect(b.sessions.openSubagent).toHaveBeenCalledWith(address)
    expect(b.sessions.open).not.toHaveBeenCalled()
    expect(b.showConversation).toHaveBeenCalledOnce()
  })
  it('does not fabricate missing addresses or reveal a failed navigation', async () => {
    const b = bench()
    await expect(b.navigation.open(id('child'))).rejects.toThrow()
    expect(b.sessions.openSubagent).not.toHaveBeenCalled()
    expect(b.showConversation).not.toHaveBeenCalled()
  })
  it.each(['dispose', 'supersede', 'duplicate'] as const)('fences a pending child resolution on %s', async (action) => {
    const b = bench()
    let resolve!: () => void
    b.sessions.refreshSubagents.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    const first = b.navigation.open(id('child'))
    if (action === 'dispose') b.navigation.dispose()
    if (action === 'supersede') await b.navigation.open(id('root'))
    const duplicate = action === 'duplicate' ? b.navigation.open(id('child')) : undefined
    b.setAddress({ parentSessionId: id('parent'), childSessionId: id('child'), mode: 'continuable' })
    resolve()
    await Promise.all([first, duplicate])
    expect(b.sessions.refreshSubagents).toHaveBeenCalledOnce()
    expect(b.sessions.openSubagent).toHaveBeenCalledTimes(action === 'duplicate' ? 1 : 0)
  })
})
