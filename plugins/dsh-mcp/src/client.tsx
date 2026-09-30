import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots / ctx.locale 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { McpSection, type McpPanelEnv } from './client/McpSection'
import { NS, en, zh, type McpT } from './client/locales'
import { McpStore } from './client/store'

export const inject: string[] = [
  'slots',
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp: copy dictionaries')
  // 导航 label thunk 与面板注入面共用一个绑定取词函数：调用时读取当前语言，
  // 新鲜度由 locale revision 驱动的 outlet 重绘保证。
  const t: McpT = ctx.locale.bind(NS)
  const store = new McpStore()
  const env: McpPanelEnv = { store, t }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-mcp',
        order: 41,
        label: () => t('section.label'),
        inject: (): McpPanelEnv => env,
      },
      McpSection,
    )
  })
}
