/** Desktop Harness Studio over recorded Session facts and a separate current Host inventory. */
import type { PluginInventorySnapshot } from '@deepseek-ai/dsh-api-remotes/client'
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
export const inject = ['slots', 'locale', 'layout', 'trajectory', 'remote', 'remote.pluginInventory']

/** Install the optional read-only Studio workspace. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('studio', { zh, en }), 'ui-harness-studio: dictionaries')
  const listPlugins = async (): Promise<PluginInventorySnapshot> => {
    const response = await ctx.remote.pluginInventory.list()
    if (!response.ok) throw new Error(`pluginInventory.list failed: ${response.error.code}`)
    return response.value
  }
  const injected = (): StudioInjected => ({
    listPlugins,
    inspect: snapshot => ctx.trajectory.inspect(snapshot),
    back: () => { ctx.layout.showConversation() },
  })
  ctx.slots.inject('shell.studio', () => ctx.slots.register({
    name: 'shell.studio', locale: 'studio', inject: injected,
  }, HarnessStudio))
}
