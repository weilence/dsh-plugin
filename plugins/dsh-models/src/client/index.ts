import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForms, SettingsSchemaService } from '@deepseek-ai/dsh-client-ui-settings/client'
import { readChoices } from '../pi-ai/choices'
import { createOperations, type PiAiOperations } from './operations'
import { PanelStore, type StoreContext } from './store'
import { ModelCatalogSection } from './ModelCatalogSection'

interface SlotServiceLike {
  inject(name: string, register: () => unknown): void
  register(options: Record<string, unknown>, component: unknown): unknown
}

interface SectionContext extends StoreContext {
  slots: SlotServiceLike
}

interface OfficialServices {
  configForms: Pick<ConfigForms, 'get' | 'describe'>
  settingsSchema: Pick<SettingsSchemaService, 'rehydrate'>
}

interface CordisLike extends SectionContext, OfficialServices {
  effect(body: () => (() => void) | void, label?: string): unknown
}

interface Injected {
  store: PanelStore
  operations: PiAiOperations
}

function choicesFromContext(ctx: SectionContext & OfficialServices): () => ReturnType<typeof readChoices> {
  return () => {
    try {
      const view = ctx.configForms.describe().getSnapshot().view
      const row = view?.namespaces.find((entry) => entry.ns === 'llm-pi-ai')
      if (row !== undefined) return readChoices(ctx.settingsSchema.rehydrate(row.schema))
    } catch {
      // 镜像不可用，走 FALLBACK_CHOICES。
    }
    return readChoices(undefined)
  }
}

export const inject: string[] = [
  'slots',
  'remote',
  'remote.llm',
  'remote.settings',
  'remote.credentials',
  'configForms',
  'settingsSchema',
]

export function apply(ctx: unknown) {
  // 与官方服务面对接的唯一断言点：Cordis 经 module augmentation 提供全部
  // 服务，本插件只消费使用的成员，其余代码走本地结构化类型。
  const services = ctx as CordisLike
  const operations = createOperations(services as unknown as Parameters<typeof createOperations>[0])
  const scope = services.configForms.get('llm-pi-ai')
  const getChoices = choicesFromContext(services)
  const store = new PanelStore({ ctx: services, operations, scope, getChoices })
  services.effect(() => store.start(), 'dsh-models: model catalog panel')
  const slots = services.slots
  slots.inject('settings.section', () =>
    slots.register(
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
