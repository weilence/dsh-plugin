import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { NS, en, zh, type RemoteT } from './client/locales'
import { RemoteSection, type RemotePanelEnv } from './client/RemoteSection'
import { RemoteStore } from './client/store'

export const inject: string[] = ['slots', 'locale']

export function apply(ctx: ClientContext) {
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote: copy dictionaries')
  // 导航 label thunk 用 apply 域绑定；面板的 t 由注册声明 locale 命名空间获得
  // 框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  const store = new RemoteStore()
  const env: RemotePanelEnv = { store }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-remote',
        order: 42,
        label: () => t('section.label'),
        locale: NS,
        inject: (): RemotePanelEnv => env,
      },
      RemoteSection,
    )
  })
}
