// llm-pi-ai profile 的状态判定、有效值合成与写入候选构造。
//
// 官方语义（`dsh-llm-pi-ai` 的 config.d.ts / catalog.d.ts / README）：
//   - `models` 是「整体替换」安装目录；每个条目从同 id 安装目录模型取
//     未设置字段的默认值。
//   - `modelOverrides` 是「定向重塑」：只改目录里的一个模型，其余照旧服务；
//     它与 `models` 互斥、不能用在手工声明 route 上、也不能点名目录未描述的模型。
//   - 手工声明 route 必须自带 `api`、`baseURL` 与非空 `models`。
//
// 写入语义的关键事实（读自 dsh-settings 的 applyPathOp + write）：
// `settings.mutate` 的 ops 作用在 **raw user 层**，`set` 是整值替换而不是与
// 原有用户字段递归合并。因此候选 profile 必须从「用户层现有 profile」克隆，
// 绝不能从合成后的 effective profile 构造——那会把 schema 默认值与组合 base
// 层字段物化进用户配置。
//
// 本文件不依赖 React / Cordis：全部是纯函数，可单测。

import type { PiAiModelEntry, PiAiProviderEntry, RouteSource } from './types'
import { normalizeModelEntry } from './normalize'
import { normalizeReasoningEfforts, validateModelEntry, type FieldIssue } from './validate'

export { normalizeModelEntry } from './normalize'

export interface DiscoveredModelFacts {
	name?: string
	contextWindow?: number
	maxTokens?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
	return structuredClone(value)
}

function firstString(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.length > 0) return candidate
	}
	return undefined
}

/** 一个模型在面板上的展示行。 */
export interface ModelRow {
	/** 模型 id（请求 id / 目录键）。 */
	id: string
	/** 展示名（用户字段 → 目录名 → id）。 */
	name: string
	/** 用户层 entry（无则 undefined）。 */
	userEntry: PiAiModelEntry | undefined
	/** 安装目录里同 id 模型的已知事实（仅目录 route 有）。 */
	catalogEntry: PiAiModelEntry | undefined
	/** 该行落在用户层哪个位置。 */
	writeSite: 'models' | 'modelOverrides' | 'catalog'
}

/** 一个 route 在面板上的完整视图。 */
export interface RouteView {
	provider: string
	displayName: string
	/** pi-ai 是否在该键下不提供任何内容（settings 目录的 `declared`）。 */
	declared: boolean
	/**
	 * 该 route 当前是否有活动 registration（Host 目录的 `active`）。
	 * 只有已配置的 route 会被注册，因此 active 蕴含 configured。
	 */
	active: boolean
	/**
	 * 该 route 是否**真的被配置过**（组合 base 或用户层写了 `providers.<route>`）。
	 *
	 * 官方 `llm-pi-ai` 会把整份 pi-ai 内置目录都声明进可配置目录
	 * （`directoryEntries()`：`for (const provider of catalog) declare(...)`），
	 * 好让配置界面在任何路由存在之前就能提供完整目录；真正注册的 route 只有
	 * `profiles()` 里存在的那些（`const routes = [...profiles().keys()]`）。
	 *
	 * 面板行列表按官方 Models 页同一规则只展示已配置项，未配置的内置 provider
	 * 只出现在「添加 Provider」下拉里。
	 */
	configured: boolean
	/** 该 route 当前是否有活动 registration（Host 目录的 `active`）。 */

	/** Host 报告的配置诊断。 */
	error?: string
	source: RouteSource
	api: string | undefined
	baseURL: string | undefined
	apiKeyEnv: string | undefined
	/** 用户层写的 profile（原始，未套 base）。 */
	userProfile: PiAiProviderEntry | undefined
	/** 合成后的有效 profile（base + user + schema 默认）。 */
	effectiveProfile: PiAiProviderEntry | undefined
	/** 面板展示的模型行。 */
	models: ModelRow[]
	/** route 级 compat（用户层优先，其次合成值）。 */
	compat: Record<string, unknown> | undefined
	/**
	 * 用户层自己写的 compat。编辑必须以它为起点：从合成值起步会把 pi-ai 的
	 * 探测默认（或组合 base 的值）物化进用户配置，之后目录升级不再生效。
	 */
	userCompat: Record<string, unknown> | undefined
}

/** 从 profile 里取非空 `models` 数组。 */
export function modelEntries(profile: PiAiProviderEntry | undefined): PiAiModelEntry[] {
	const list = profile?.models
	if (!Array.isArray(list)) return []
	return list.filter(
		(entry): entry is PiAiModelEntry =>
			isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0,
	)
}

/** 从 profile 里取 `modelOverrides` 字典。 */
export function overrideEntries(profile: PiAiProviderEntry | undefined): Record<string, PiAiModelEntry> {
	const overrides = profile?.modelOverrides
	if (!isRecord(overrides)) return {}
	const result: Record<string, PiAiModelEntry> = {}
	for (const [id, value] of Object.entries(overrides)) {
		if (isRecord(value)) result[id] = value as PiAiModelEntry
	}
	return result
}

/** 把一个安装目录模型事实折叠成面板条目。 */
function catalogEntryOf(id: string, facts: DiscoveredModelFacts | undefined): PiAiModelEntry | undefined {
	if (facts === undefined) return undefined
	const entry: PiAiModelEntry = { id }
	if (facts.name !== undefined && facts.name !== id) entry.name = facts.name
	if (facts.contextWindow !== undefined) entry.contextWindow = facts.contextWindow
	if (facts.maxTokens !== undefined) entry.maxTokens = facts.maxTokens
	return entry
}

/**
 * 判定一个 route 的来源状态。
 * @param declared pi-ai 是否不提供该 route（settings 目录的 `declared`）。
 * @param userProfile 用户层写的 profile（可能只覆盖了少数字段）。
 */
export function routeSource(declared: boolean, userProfile: PiAiProviderEntry | undefined): RouteSource {
	if (declared) return 'declared'
	if (modelEntries(userProfile).length > 0) return 'explicit'
	if (Object.keys(overrideEntries(userProfile)).length > 0) return 'overridden'
	return 'inherited'
}

/**
 * 面板展示的模型行。
 * 显式清单/手工 route：用户层数组原样；目录 route：安装目录全集，
 * 套上用户 override，再补上 override 点名了目录没有的模型（供修复/删除）。
 */
export function routeModelRows(
	source: RouteSource,
	userProfile: PiAiProviderEntry | undefined,
	catalog: ReadonlyMap<string, DiscoveredModelFacts>,
): ModelRow[] {
	if (source === 'explicit' || source === 'declared') {
		return modelEntries(userProfile).map((entry) => ({
			id: entry.id,
			name: firstString(entry.name, entry.id) ?? entry.id,
			userEntry: entry,
			catalogEntry: undefined,
			writeSite: 'models' as const,
		}))
	}
	const overrides = overrideEntries(userProfile)
	const rows: ModelRow[] = []
	const seen = new Set<string>()
	for (const [id, facts] of catalog) {
		const override = overrides[id]
		rows.push({
			id,
			name: firstString(override?.name, facts.name, id) ?? id,
			userEntry: override,
			catalogEntry: catalogEntryOf(id, facts),
			writeSite: override === undefined ? 'catalog' : 'modelOverrides',
		})
		seen.add(id)
	}
	for (const [id, override] of Object.entries(overrides)) {
		if (seen.has(id)) continue
		rows.push({
			id,
			name: firstString(override.name, id) ?? id,
			userEntry: override,
			catalogEntry: undefined,
			writeSite: 'modelOverrides',
		})
	}
	return rows
}

/** 合成一个模型的有效展示值（用户层 → 目录 → route 默认）。 */
export function effectiveModel(
	row: ModelRow,
	route: { defaultContextWindow?: unknown; defaultMaxTokens?: unknown },
): {
	contextWindow: number | undefined
	maxTokens: number | undefined
	input: readonly string[] | undefined
} {
	const contextWindow = row.userEntry?.contextWindow ?? row.catalogEntry?.contextWindow
	const maxTokens = row.userEntry?.maxTokens ?? row.catalogEntry?.maxTokens
	const input = row.userEntry?.input ?? row.catalogEntry?.input
	return {
		contextWindow:
			typeof contextWindow === 'number' ? contextWindow : toPositiveInt(route.defaultContextWindow),
		maxTokens: typeof maxTokens === 'number' ? maxTokens : toPositiveInt(route.defaultMaxTokens),
		input: Array.isArray(input) ? input : undefined,
	}
}

function toPositiveInt(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 从用户层 profile 与合成 profile 中取 route 级 compat（用户层优先）。 */
export function routeCompat(
	userProfile: PiAiProviderEntry | undefined,
	effectiveProfile: PiAiProviderEntry | undefined,
): Record<string, unknown> | undefined {
	if (isRecord(userProfile?.compat)) return userProfile.compat as Record<string, unknown>
	if (isRecord(effectiveProfile?.compat)) return effectiveProfile.compat as Record<string, unknown>
	return undefined
}

/**
 * 计算写回用户层的一份新 profile。
 *
 * `settings.mutate` 的 `set` 是整值替换，因此这里基于「用户层现有 profile」
 * 克隆，而不是合成后的 effective profile。
 *
 * @param userProfile 用户层现有 profile（可能 undefined）。
 * @param patch 本次要覆盖的字段；值为 undefined 表示「从用户层删除该字段」。
 */
export function patchUserProfile(
	userProfile: PiAiProviderEntry | undefined,
	patch: Record<string, unknown | undefined>,
): PiAiProviderEntry {
	const next: Record<string, unknown> = isRecord(userProfile) ? cloneJson(userProfile) : {}
	for (const [key, value] of Object.entries(patch)) {
		if (value === undefined) delete next[key]
		else next[key] = cloneJson(value)
	}
	return next as PiAiProviderEntry
}

/**
 * 一个条目是否与安装目录默认值等价（用于「保存后恢复继承」）。
 *
 * 官方语义是「未设置的字段从同 id 安装目录模型取默认值」，因此条目缺席的
 * 字段等于继承，不需要与目录相等；只有条目明确写出的字段才参与比较。
 */
export function entryMatchesCatalog(
	entry: PiAiModelEntry | undefined,
	catalogEntry: PiAiModelEntry | undefined,
): boolean {
	if (entry === undefined) return true
	if (catalogEntry === undefined) return false
	for (const [key, value] of Object.entries(entry)) {
		if (key === 'id') continue
		if (JSON.stringify(value) !== JSON.stringify((catalogEntry as Record<string, unknown>)[key])) {
			return false
		}
	}
	return true
}

/**
 * 保存一个模型条目的能力设置，返回新的用户层 profile。
 *
 * - 目录 route（inherited/overridden）写 `modelOverrides.<id>`；
 *   条目与目录默认等价时删除该 override（恢复继承）。
 * - 显式清单/手工 route 重写 `models` 数组里的对应条目。
 *
 * @param source route 来源状态。
 * @param userProfile 用户层现有 profile。
 * @param row 编辑前的行。
 * @param nextEntry 编辑后的条目（id 必须与 row.id 相同）。
 * @returns 新的用户层 profile 候选。
 */
export function saveModelProfile(
	source: RouteSource,
	userProfile: PiAiProviderEntry | undefined,
	row: ModelRow,
	nextEntry: PiAiModelEntry,
): PiAiProviderEntry {
	const normalized = normalizeModelEntry(nextEntry)
	if (source === 'explicit' || source === 'declared') {
		const list = modelEntries(userProfile)
		const next = list.map((entry) => (entry.id === row.id ? normalized : entry))
		return patchUserProfile(userProfile, { models: next })
	}
	const overrides = overrideEntries(userProfile)
	if (entryMatchesCatalog(normalized, row.catalogEntry)) delete overrides[row.id]
	else overrides[row.id] = normalized
	return patchUserProfile(userProfile, {
		modelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
	})
}

/** 删除一个模型，返回新的用户层 profile 候选。 */
export function removeModelProfile(
	source: RouteSource,
	userProfile: PiAiProviderEntry | undefined,
	row: ModelRow,
): PiAiProviderEntry {
	if (source === 'explicit' || source === 'declared') {
		return patchUserProfile(userProfile, {
			models: modelEntries(userProfile).filter((entry) => entry.id !== row.id),
		})
	}
	const overrides = overrideEntries(userProfile)
	// 目录 route 的「删除」只能删掉这条 override；目录本身由 pi-ai 提供，
	// 面板不物化整表（物化是「新增目录未描述模型」才有的显式动作）。
	delete overrides[row.id]
	return patchUserProfile(userProfile, {
		modelOverrides: Object.keys(overrides).length > 0 ? overrides : undefined,
	})
}

/**
 * 向目录 route 新增一个安装目录没有描述的模型。
 *
 * `modelOverrides` 不能点名目录未描述的模型，因此必须物化显式 `models`：
 * 目录里已有的条目按用户 override 折叠后逐个列出，再追加新条目。
 * 这是唯一会触发物化的路径，UI 必须二次确认。
 *
 * @param catalog 安装目录全集（来自 llm/discoverModels）。
 * @returns 新的用户层 profile 候选与新增条目数。
 */
export function materializeWithNewModel(
	userProfile: PiAiProviderEntry | undefined,
	catalog: ReadonlyMap<string, DiscoveredModelFacts>,
	newEntry: PiAiModelEntry,
): PiAiProviderEntry {
	const overrides = overrideEntries(userProfile)
	const list: PiAiModelEntry[] = []
	for (const [id, facts] of catalog) {
		const base = catalogEntryOf(id, facts) ?? { id }
		const override = overrides[id]
		list.push(normalizeModelEntry(override === undefined ? base : { ...base, ...override }))
	}
	list.push(normalizeModelEntry(newEntry))
	return patchUserProfile(userProfile, { models: list, modelOverrides: undefined })
}

/** 恢复一个目录 route 的目录继承（删除用户层的 models 与 modelOverrides）。 */
export function resetToCatalog(userProfile: PiAiProviderEntry | undefined): PiAiProviderEntry {
	return patchUserProfile(userProfile, { models: undefined, modelOverrides: undefined })
}

/**
 * 面板对一个模型行编辑结果的字段级校验。
 * 重复 id 由调用方通过 {@link modelIdExists} 单独判断（编辑既有行时它必然
 * 存在，不能算冲突）。
 */
export function validateRow(entry: PiAiModelEntry): FieldIssue[] {
	return validateModelEntry(entry)
}

/** 新增行在目标 route 上是否与既有行冲突。 */
export function modelIdExists(rows: readonly ModelRow[], id: string): boolean {
	return rows.some((row) => row.id === id)
}

export { normalizeReasoningEfforts }

/** 「新增模型」的写入方案：真正写入与预览共用同一条路径。 */
export type AddModelPlan =
	/** 目录 route 上覆盖目录已描述的模型：只写 modelOverrides。 */
	| { kind: 'override'; profile: PiAiProviderEntry }
	/** 追加到已有显式清单 / 手写清单。 */
	| { kind: 'append'; profile: PiAiProviderEntry }
	/** 物化整份目录并追加新模型（官方 modelOverrides 不能点名目录未描述的模型）。 */
	| { kind: 'materialize'; profile: PiAiProviderEntry }
	/** 缺少前提，无法安全写入。 */
	| { kind: 'blocked'; reason: string }

/**
 * 规划一次「新增模型」。
 *
 * 目录 route 上新增目录**已描述**的模型只写 `modelOverrides`；新增目录**未描述**
 * 的模型必须物化整份 `models`（官方语义），而物化要求先能读到当前继承的完整
 * 目录，否则会把 route 悄悄收窄成只有这一个模型——那种情况直接 blocked。
 *
 * 预览与写入都调用它，因此面板展示的文本就是将要提交的候选。
 */
export function planAddModel(input: {
	source: RouteSource
	userProfile: PiAiProviderEntry | undefined
	/** 该 route 安装目录里的模型 id → 已知事实（手工 route 为空）。 */
	catalog: ReadonlyMap<string, DiscoveredModelFacts>
	entry: PiAiModelEntry
}): AddModelPlan {
	const { source, userProfile, catalog, entry } = input
	if (source === 'explicit' || source === 'declared') {
		return {
			kind: 'append',
			profile: patchUserProfile(userProfile, {
				models: [...modelEntries(userProfile), entry],
				modelOverrides: undefined,
			}),
		}
	}
	if (catalog.has(entry.id)) {
		const overrides = overrideEntries(userProfile)
		overrides[entry.id] = entry
		return { kind: 'override', profile: patchUserProfile(userProfile, { modelOverrides: overrides }) }
	}
	if (catalog.size === 0) {
		return {
			kind: 'blocked',
			reason: '无法读取该 route 当前继承的模型目录；物化整份清单会把其余模型丢掉，已取消。请先刷新重试。',
		}
	}
	return { kind: 'materialize', profile: materializeWithNewModel(userProfile, catalog, entry) }
}
