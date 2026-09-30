import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots / ctx.locale 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SearchSwitchSection, type SearchSwitchPanelEnv } from './SearchSwitchSection'
import { SearchSwitchStore } from './store'
import { NS, en, zh } from './locales'

export const inject: string[] = ['slots', 'locale']

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-zhipu-tools: copy dictionaries')
  const t = ctx.locale.bind(NS)
  const store = new SearchSwitchStore(t)
  const env: SearchSwitchPanelEnv = { store, t }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-zhipu-tools',
        order: 42,
        label: () => t('section.label'),
        inject: (): SearchSwitchPanelEnv => env,
      },
      SearchSwitchSection,
    )
  })
}
