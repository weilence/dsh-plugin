// 客户端入口（tsdown browser half 的构建目标，产物 lib/client.js）。
//
// 职责只有「接线」：从宿主 cordis Context 收窄出本插件用到的服务面，
// 组装 operations + PanelStore，并把模型目录面板注册成独立的
// settings.section（id: dsh-models, order: 12）。页面自身的读写策略：
//   - 读走 configForms 的共享镜像 + Host 只读能力桥（operations.ts）；
//   - 写走 settings.mutate，一次保存 = 一个整值 set/unset 目标 route 子树
//     （store.ts）。
//
// 目录导览：
//   - ModelCatalogSection.tsx   列表页（含 RouteRow 行卡片与拖拽排序）；
//   - CreateProviderDialog.tsx  「新建 Provider」弹窗（内置 / models.dev 自定义）；
//   - RouteEditor.tsx           编辑页（连接字段 + 模型清单 + YAML 预览）；
//   - ModelForm.tsx             单个模型的能力编辑表单；
//   - ModelsDevImport.tsx       models.dev 自定义 Provider 表单；
//   - ModelTable.tsx / ConfirmDialog.tsx / ui.tsx / drag.ts  共用控件；
//   - store.ts / operations.ts / utils.ts   状态层与宿主操作。

import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { readChoices } from '../pi-ai/choices'
import { createOperations, type PiAiOperations } from './operations'
import { PanelStore, type ConfigFormLike, type StoreContext } from './store'
import { ModelCatalogSection } from './ModelCatalogSection'

interface SlotServiceLike {
	inject(name: string, register: () => unknown): void
	register(options: Record<string, unknown>, component: unknown): unknown
}

interface SectionContext extends StoreContext {
	slots: SlotServiceLike
}

/** configForms/settingsSchema 来自官方 client 包的 module augmentation。 */
interface OfficialServices {
	configForms: {
		get(entryId: string): ConfigFormLike
		describe(): {
			getSnapshot(): { view?: { namespaces: readonly { ns: string; schema: unknown }[] } }
		}
	}
	settingsSchema: { rehydrate(serialized: unknown): unknown }
}

/** cordis Context 的最小面（避免与官方 module augmentation 的结构冲突）。 */
interface CordisLike extends SectionContext, OfficialServices {
	effect(body: () => (() => void) | void, label?: string): unknown
}

/** settings.section 插槽注入给组件的载荷（ModelCatalogSectionProps 的必选部分）。 */
interface Injected {
	store: PanelStore
	operations: PiAiOperations
}

/** 从 namespace schema envelope 读选项（每次渲染时重读，schema 变了自然跟上）。 */
function choicesFromContext(ctx: SectionContext & OfficialServices): () => ReturnType<typeof readChoices> {
	return () => {
		try {
			const view = ctx.configForms.describe().getSnapshot().view
			const row = view?.namespaces.find((entry) => entry.ns === 'llm-pi-ai')
			if (row !== undefined) return readChoices(ctx.settingsSchema.rehydrate(row.schema))
		} catch {
			// 镜像不可用时回退到内置默认值。
		}
		return readChoices(undefined)
	}
}

/** 注册独立的 settings.section。 */
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
	// 与官方服务面对接的唯一断言点：Cordis 通过 module augmentation 提供
	// configForms / settingsSchema / remote / slots，而本插件只消费其中
	// 使用的成员，故在此一次性收窄，其余代码全部走本地结构化类型。
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
