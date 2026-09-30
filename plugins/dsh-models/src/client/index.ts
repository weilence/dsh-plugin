import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { readChoices } from '../pi-ai/choices'
import { createOperations, type PiAiOperations } from './operations'
import { PanelStore } from './store'
import { NS, en, zh } from './locales'
import { ModelCatalogSection } from './ModelCatalogSection'
import { ProviderUsageChip } from './usage/UsageChip'

interface Injected {
  store: PanelStore
  operations: PiAiOperations
}

export const inject: string[] = [
  'slots',
  'remote',
  'remote.llm',
  'remote.settings',
  'remote.credentials',
  'configForms',
  'settingsSchema',
  'modelDirectories',
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-models: copy dictionaries')
  // 导航 label thunk 用 apply 域绑定（调用时读当前语言）；面板的 t 由注册声明
  // locale 命名空间获得框架标准 seat——每个语言切换换新函数引用，memo 组件
  // 靠浅比较自动刷新。
  const t = ctx.locale.bind(NS)
  const operations = createOperations(ctx)
  const scope = ctx.configForms.get('llm-pi-ai')
  const getChoices = () => {
    try {
      const view = ctx.configForms.describe().getSnapshot().view
      const row = view?.namespaces.find((entry) => entry.ns === 'llm-pi-ai')
      if (row !== undefined) return readChoices(ctx.settingsSchema.rehydrate(row.schema))
    } catch {
      // 镜像不可用，走 FALLBACK_CHOICES。
    }
    return readChoices(undefined)
  }
  const store = new PanelStore({ ctx, operations, scope, getChoices })
  ctx.effect(() => store.start(), 'dsh-models: model catalog panel')
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.right',
        id: 'dsh-models-usage',
        order: 10,
        locale: NS,
        inject: (sessionId: SessionId) => ({
          sessionId,
          directories: ctx.modelDirectories,
          locale: ctx.locale,
        }),
      },
      ProviderUsageChip,
    ),
  )
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-models',
        order: 12,
        label: () => t('section.label'),
        locale: NS,
        inject: (): Injected => ({ store, operations }),
      },
      ModelCatalogSection,
    ),
  )
}
