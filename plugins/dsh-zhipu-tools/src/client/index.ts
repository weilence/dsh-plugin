import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SearchSwitchSection, type SearchSwitchPanelEnv } from './SearchSwitchSection'
import { SearchSwitchStore } from './store'

export const inject: string[] = ['slots']

export function apply(ctx: ClientContext) {
  const store = new SearchSwitchStore()
  const env: SearchSwitchPanelEnv = { store }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-zhipu-tools',
        order: 42,
        label: () => '智谱搜索',
        inject: (): SearchSwitchPanelEnv => env,
      },
      SearchSwitchSection,
    )
  })
}
