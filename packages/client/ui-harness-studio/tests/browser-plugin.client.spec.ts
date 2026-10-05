import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'
import { HarnessStudio, type StudioInjected } from '../src/client/HarnessStudio.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const layout = { showConversation: vi.fn() }
  ctx.provide('layout', layout as never)
  const inspect = vi.fn(() => undefined)
  ctx.provide('trajectory', { inspect })
  class RemoteService extends Service {
    constructor(serviceCtx: Context) { super(serviceCtx, 'remote') }
  }
  new RemoteService(ctx)
  const list = vi.fn(async () => ({ ok: true as const, value: { entries: [] } }))
  ctx.provide('remote.pluginInventory', { list })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, inspect, list, layout }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({ name: 'root', children: {
    'shell.studio': { kind: 'single', scope: 'session-maybe' },
  } } as never, () => null)
}

describe('ui-harness-studio registration', () => {
  it('contributes no Host behavior', () => {
    expect(applyHost).not.toThrow()
  })

  it('contributes no Host behavior and waits for the Studio declaration', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.entries('shell.studio')).toHaveLength(0)
    const stop = declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('shell.studio')).toHaveLength(1) })
    const entry = b.slots.entries('shell.studio')[0]!
    expect(entry.component).toBe(HarnessStudio)
    expect(b.list).not.toHaveBeenCalled()
    const injected = (entry.inject as unknown as () => StudioInjected)()
    await expect(injected.listPlugins()).resolves.toEqual({ entries: [] })
    expect(b.list).toHaveBeenCalledOnce()
    b.list.mockResolvedValueOnce({ ok: false, error: { code: 'unavailable' } } as never)
    await expect(injected.listPlugins()).rejects.toThrow('pluginInventory.list failed: unavailable')
    injected.inspect({} as never)
    expect(b.inspect).toHaveBeenCalledOnce()
    injected.back()
    expect(b.layout.showConversation).toHaveBeenCalledOnce()
    stop()
    expect(b.slots.entries('shell.studio')).toHaveLength(0)
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('shell.studio')).toHaveLength(1) })
    await fiber.dispose()
    expect(b.slots.entries('shell.studio')).toHaveLength(0)
    await b.ctx.fiber.dispose()
  })
})
