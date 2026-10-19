import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：plugins.bundle.config 槽位契约、ctx.slots / ctx.locale / ctx.remote 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ConfigSection, type ConfigSectionInjected } from './ConfigSection'
import { ConfigStore } from './store'
import { NS, en, zh } from './locales'

export const inject: string[] = ['slots', 'locale', 'remote']

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-zhipu-tools: copy dictionaries')

  const store = new ConfigStore()
  const injected: ConfigSectionInjected = { store }

  // 外部改 patch（手工编辑、官方设置页写入）会经 settings 服务的 document-updated
  // 事件由 remotes 通道广播到客户端：收到 web 行的更新即刷新，开关状态与配置实时一致。
  ctx.effect(
    () =>
      ctx.remote.$on('settings/document-updated', (ns) => {
        if (ns !== 'web' || store.getSnapshot().pending) return
        void store.refresh()
      }),
    'dsh-zhipu-tools: document-updated refresh',
  )

  // 接入面板挂自家 bundle 详情页（keyed by 包名）：装了插件点开卡片即见，
  // 不占设置页一级导航。
  ctx.slots.inject('plugins.bundle.config', () => {
    return ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: '@weilence/dsh-zhipu-tools',
        locale: NS,
        inject: (): ConfigSectionInjected => injected,
      },
      ConfigSection,
    )
  })
}
