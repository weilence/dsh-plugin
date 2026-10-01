import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：plugins.bundle.config 槽位契约、ctx.slots / ctx.locale 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SearchSwitchSection, type SearchSwitchSectionInjected } from './SearchSwitchSection'
import { SearchSwitchStore } from './store'
import { NS, en, zh } from './locales'

export const inject: string[] = ['slots', 'locale']

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-zhipu-tools: copy dictionaries')
  // store 即显 notice 用 apply 域绑定；面板的 t 由注册声明 locale 命名空间获得
  // 框架标准 seat（每个语言切换换新引用）。
  const t = ctx.locale.bind(NS)
  const store = new SearchSwitchStore(t)
  const injected: SearchSwitchSectionInjected = { store }

  // 开关挂自家 bundle 详情页（keyed by 包名）：装了插件点开卡片即见开关，
  // 不再占设置页一级导航。
  ctx.slots.inject('plugins.bundle.config', () => {
    return ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: '@weilence/dsh-zhipu-tools',
        locale: NS,
        inject: (): SearchSwitchSectionInjected => injected,
      },
      SearchSwitchSection,
    )
  })
}
