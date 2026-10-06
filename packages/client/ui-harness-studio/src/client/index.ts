/** Desktop Harness Studio over recorded Session facts and a separate current Host inventory. */
import type { AgentPresetCompositionView, ConnectionHandle, PluginInventorySnapshot, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-trajectory/client'
import { en, zh, type StudioKey } from './locales.ts'
import { HarnessStudio, type StudioInjected } from './HarnessStudio.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task-scoped runtime inspection copy. */
    studio: StudioKey
  }
}

/** Services needed for the Studio slot, locale, and current Host inventory. */
export const inject = ['slots', 'locale', 'layout', 'trajectory', 'remote', 'remote.pluginInventory', 'connection']

/** Install the optional read-only Studio workspace. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('studio', { zh, en }), 'ui-harness-studio: dictionaries')
  const listPlugins = async (): Promise<PluginInventorySnapshot> => {
    const response = await ctx.remote.pluginInventory.list()
    if (!response.ok) throw new Error(`pluginInventory.list failed: ${response.error.code}`)
    return response.value
  }
  const readComposition = async (sessionId: SessionId): Promise<{ composition: AgentPresetCompositionView | null; seq: number | null }> => {
    const connection = ctx.get('connection') as ConnectionHandle
    const response = await connection.api.agentPresets.composition({ sessionId })
    if (!response.result.ok) throw new Error(`agentPreset.composition failed: ${response.result.error.code}`)
    return response.result.value
  }
  const injected = (): StudioInjected => ({
    listPlugins,
    readComposition,
    inspect: snapshot => ctx.trajectory.inspect(snapshot),
    back: () => { ctx.layout.showConversation() },
  })
  ctx.slots.inject('shell.studio', () => ctx.slots.register({
    name: 'shell.studio', locale: 'studio', inject: injected,
  }, HarnessStudio))
}
