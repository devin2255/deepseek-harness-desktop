/** Offline work and Agent publication compete at the registry's authoritative entry. */

import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentOfflineReservationError, type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'

function entry(ctx: Context, id: SessionId): Agent {
  return { id, session: Session.create(id), status: 'idle', ctx } as Agent
}

describe('offline Session reservations', () => {
  it('holds deduplicated identities, preserves initiator attribution, and releases only its captured batch', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const first = SessionId('first')
    const second = SessionId('second')
    const parent = entry(ctx, SessionId('parent'))
    const release = Promise.withResolvers<undefined>()
    const ids = [first, first]
    const operation = ctx.agents.withInitiator(parent, () => ctx.agents.withOfflineSessions(ids, async () => {
      expect(ctx.agents.currentInitiator()).toBe(parent)
      await release.promise
      expect(ctx.agents.currentInitiator()).toBe(parent)
      return 42
    }))
    ids.splice(0, ids.length, second)
    expect(() => ctx.agents.enter(entry(ctx, first), undefined)).toThrow(AgentOfflineReservationError)
    await expect(ctx.agents.create({ sessionId: first })).rejects.toThrow(AgentOfflineReservationError)
    await expect(ctx.agents.resume({ resumeSessionId: first })).rejects.toThrow(AgentOfflineReservationError)
    expect(ctx.agents.get(first)).toBeUndefined()
    await expect(ctx.agents.withOfflineSessions([second], () => Promise.resolve('independent'))).resolves.toBe('independent')
    release.resolve(undefined)
    await expect(operation).resolves.toBe(42)
    const remove = ctx.agents.enter(entry(ctx, first), undefined)
    remove()
    await ctx.fiber.dispose()
  })

  it('rejects live and overlapping batches atomically without reserving their other identities', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const first = SessionId('first')
    const second = SessionId('second')
    const remove = ctx.agents.enter(entry(ctx, second), undefined)
    await expect(ctx.agents.withOfflineSessions([first, second], () => Promise.resolve())).rejects.toThrow(AgentOfflineReservationError)
    await expect(ctx.agents.withOfflineSessions([first], () => Promise.resolve('free'))).resolves.toBe('free')
    remove()
    const release = Promise.withResolvers<undefined>()
    const held = ctx.agents.withOfflineSessions([second], () => release.promise)
    await expect(ctx.agents.withOfflineSessions([first, second], () => Promise.resolve())).rejects.toThrow(AgentOfflineReservationError)
    await expect(ctx.agents.withOfflineSessions([first], () => Promise.resolve('still free'))).resolves.toBe('still free')
    release.resolve(undefined)
    await held
    await expect(ctx.agents.withOfflineSessions([], () => Promise.resolve('empty'))).resolves.toBe('empty')
    await ctx.fiber.dispose()
  })

  it('releases reservations on synchronous failure, rejection, and cooperative cancellation', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const id = SessionId('failure')
    const error = new Error('offline failure')
    await expect(ctx.agents.withOfflineSessions([id], () => { throw error })).rejects.toBe(error)
    await expect(ctx.agents.withOfflineSessions([id], () => Promise.reject(error))).rejects.toBe(error)
    const abort = new AbortController()
    const release = Promise.withResolvers<undefined>()
    const held = ctx.agents.withOfflineSessions([id], async () => { await release.promise; abort.signal.throwIfAborted() })
    abort.abort(error)
    release.resolve(undefined)
    await expect(held).rejects.toBe(error)
    await expect(ctx.agents.withOfflineSessions([id], () => Promise.resolve('released'))).resolves.toBe('released')
    await ctx.fiber.dispose()
  })

  it('drains an owned operation before registry teardown completes', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(AgentRegistry)
    await fiber
    const release = Promise.withResolvers<undefined>()
    const held = ctx.agents.withOfflineSessions([SessionId('drain')], () => release.promise)
    let disposed = false
    const disposing = fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await held
    await disposing
    expect(disposed).toBe(true)
    await ctx.fiber.dispose()
  })
})
