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
  // 用量面板的重置时间文案跟随宿主语言，语言环境取自 locale 插件的服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
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
        label: () => '模型',
        inject: (): Injected => ({ store, operations }),
      },
      ModelCatalogSection,
    ),
  )
}
