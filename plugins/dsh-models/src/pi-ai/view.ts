// configForms 快照 + llm 目录事实 → 面板行。
//
// 三层事实合成（顺序即官方 merge 顺序）：
//   schema 默认值 → 组合 base → 用户层
// scope.value 已是 resolve 后的结果，可直接当「有效 profile」；scope.user 是
// 原始用户层，写入候选必须以它为起点。

import type { PiAiModelEntry, PiAiProviderEntry, RouteSource } from './types'
import {
	effectiveModel,
	routeCompat,
	routeModelRows,
	routeSource,
	type DiscoveredModelFacts,
	type ModelRow,
	type RouteView,
} from './profile'
import type { EffectiveModelFacts, RouteDirectoryRow } from '../client/operations'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function providerOf(root: unknown, provider: string): PiAiProviderEntry | undefined {
	if (!isRecord(root)) return undefined
	const providers = root['providers']
	if (!isRecord(providers)) return undefined
	const profile = providers[provider]
	return isRecord(profile) ? (profile as PiAiProviderEntry) : undefined
}

/** 一个 route 构建面板行所需的全部输入。 */
export interface RouteInputs {
	directory: RouteDirectoryRow
	/** raw user 层 profile。 */
	userProfile: PiAiProviderEntry | undefined
	/** schema 默认值 → base → user 合成后的 profile。 */
	effectiveProfile: PiAiProviderEntry | undefined
	/** 安装目录事实（手工 route 为空 Map）。 */
	catalog: ReadonlyMap<string, DiscoveredModelFacts>
	/** 该 route 当前生效能力（只读桥；不可用时为空）。 */
	effective: ReadonlyMap<string, EffectiveModelFacts>
}

/** 面板行在模型行基础上补充的「当前生效能力」字段。 */
export interface PanelModelRow extends ModelRow {
	/** 只读桥回答的该模型生效事实（不可用时 undefined）。 */
	facts: EffectiveModelFacts | undefined
	/** 当前生效的上下文容量。 */
	effectiveContextWindow: number | undefined
	/** 当前生效的默认输出上限。 */
	effectiveMaxTokens: number | undefined
	/** 当前生效的输入模态。 */
	effectiveInput: readonly string[] | undefined
	/** 当前生效的可选推理档。 */
	effectiveEfforts: readonly string[] | undefined
	/** 当前生效的默认推理档。 */
	effectiveDefaultEffort: string | undefined
}

/** 面板每行渲染所需的派生视图。 */
export interface PanelRoute extends RouteView {
	/** 组件渲染用的模型行（含生效能力）。 */
	rows: PanelModelRow[]
}

/** 有效的 route compat（用户层优先）。 */
export function buildRoute(inputs: RouteInputs): PanelRoute {
	const { directory, userProfile, effectiveProfile, catalog, effective } = inputs
	const source: RouteSource = routeSource(directory.declared, userProfile)
	const models = routeModelRows(source, userProfile, catalog)
	const routeFacts = {
		defaultContextWindow: effectiveProfile?.defaultContextWindow,
		defaultMaxTokens: effectiveProfile?.defaultMaxTokens,
	}
	return {
		provider: directory.provider,
		displayName: directory.displayName,
		declared: directory.declared,
		active: directory.active,
		// 「配置过」以合成后的 section 为准：schema 默认只把 providers 物化成 {}，
		// 因此 providers.<route> 存在就说明组合 base 或用户层写过它。
		configured: effectiveProfile !== undefined,
		...(directory.error === undefined ? {} : { error: directory.error }),
		source,
		api: pickString(userProfile?.api, effectiveProfile?.api),
		baseURL: pickString(userProfile?.baseURL, effectiveProfile?.baseURL),
		apiKeyEnv: pickString(userProfile?.apiKeyEnv, effectiveProfile?.apiKeyEnv),
		userProfile,
		effectiveProfile,
		models,
		compat: routeCompat(userProfile, effectiveProfile),
		userCompat: routeCompat(userProfile, undefined),
		rows: models.map((row): PanelModelRow => {
			const facts = effective.get(row.id)
			return { ...row, facts, ...effectiveModelSummary(row, routeFacts, facts) }
		}),
	}
}

function pickString(...candidates: unknown[]): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.length > 0) return candidate
	}
	return undefined
}

/**
 * 合成一行的有效展示值：用户字段 → 生效桥 → 目录 → route 默认。
 * 生效桥（resolveModelInfo）才是请求路径看到的真值，因此优先于目录展示值。
 */
function effectiveModelSummary(
	row: ModelRow,
	routeFacts: { defaultContextWindow?: unknown; defaultMaxTokens?: unknown },
	facts: EffectiveModelFacts | undefined,
): Omit<PanelModelRow, keyof ModelRow | 'facts'> {
	const local = effectiveModel(row, routeFacts)
	return {
		effectiveContextWindow: facts?.contextWindow ?? local.contextWindow,
		effectiveMaxTokens: facts?.defaultMaxTokens ?? local.maxTokens,
		effectiveInput: facts?.inputModalities ?? local.input,
		effectiveEfforts: facts?.reasoning?.efforts?.map((effort) => effort.id),
		effectiveDefaultEffort: facts?.reasoning?.defaultEffort,
	}
}

/** 从 settings scope 快照 + llm 目录事实构建全部面板行。 */
export function buildRoutes(
	snapshot: { value: unknown; user: unknown; base: unknown },
	directory: readonly RouteDirectoryRow[],
	catalogs: ReadonlyMap<string, ReadonlyMap<string, DiscoveredModelFacts>>,
	effective: ReadonlyMap<string, ReadonlyMap<string, EffectiveModelFacts>>,
): PanelRoute[] {
	return directory.map((row) =>
		buildRoute({
			directory: row,
			userProfile: providerOf(snapshot.user, row.provider),
			effectiveProfile: providerOf(snapshot.value, row.provider),
			catalog: catalogs.get(row.provider) ?? new Map(),
			effective: effective.get(row.provider) ?? new Map(),
		}),
	)
}

/** 一个模型行的能力摘要文本（容量与模态，不含推理——推理单独一行展示）。 */
export function capabilityLabel(row: PanelModelRow): string {
	const parts: string[] = []
	if (row.effectiveContextWindow !== undefined) parts.push(`ctx ${formatCount(row.effectiveContextWindow)}`)
	if (row.effectiveMaxTokens !== undefined) parts.push(`out ${formatCount(row.effectiveMaxTokens)}`)
	if (row.effectiveInput !== undefined) parts.push(row.effectiveInput.join('+'))
	return parts.join(' · ')
}

/** 一个模型行的推理摘要文本（可选档与默认档）。 */
export function reasoningLabel(row: PanelModelRow): string {
	if (row.effectiveEfforts === undefined) return '默认'
	if (row.effectiveEfforts.length === 0) return '不支持'
	const efforts = row.effectiveEfforts.join(' / ')
	return row.effectiveDefaultEffort === undefined
		? efforts
		: `${efforts}（默认 ${row.effectiveDefaultEffort}）`
}

function formatCount(value: number) {
	if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
	if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
	return String(value)
}

/** 一个模型条目是否来自用户层（区别于纯目录继承）。 */
export function isUserModel(row: PanelRoute['rows'][number]): boolean {
	return row.userEntry !== undefined
}

/** 面板状态：一个 route 的模型是否有任何用户层覆盖。 */
export function hasOverrides(route: PanelRoute): boolean {
	if (route.source === 'explicit' || route.source === 'declared') return route.models.length > 0
	return route.models.some((row) => row.userEntry !== undefined)
}

/** 面板展示用：模型条目的来源标签。 */
export function sourceLabel(route: PanelRoute, row: PanelRoute['rows'][number]): string {
	if (route.source === 'declared') return '手写'
	if (route.source === 'explicit') return '清单'
	return row.userEntry === undefined ? '目录' : '覆盖'
}

export type { DiscoveredModelFacts, EffectiveModelFacts, ModelRow, RouteView, RouteSource }
export type { PiAiModelEntry, PiAiProviderEntry }
