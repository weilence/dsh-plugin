// models.dev 条目 → 官方 PiAiModelProfile 的映射。
//
// 只映射面板能设置、且官方语义明确的字段。价格、发布日期、知识截止等展示
// 元数据不写入 DSH。`toggle` 与 `budget_tokens` 没有通用安全的 pi-ai 映射，
// 因此不自动生成推理配置；`decision` 类型始终排除。

import type { ModelsDevModel, ModelsDevProvider } from './types'
import type { PiAiModelEntry, PiAiModality } from '../pi-ai/types'

const EFFORT_LEVELS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

function inputModalities(model: ModelsDevModel): PiAiModality[] {
	const result: PiAiModality[] = []
	if (model.modalities.input.includes('text')) result.push('text')
	if (model.modalities.input.includes('image')) result.push('image')
	return result
}

/**
 * models.dev 的 reasoning_options[type=effort] → 官方 reasoningEfforts。
 *
 * - `none`/`off` → `off: null`（官方语义：支持该等级、但不发送参数）。
 * - 已知思考等级 → 同名 wire 值。
 * - 未声明的等级不出现在字典里（等于「不提供该档」）。
 * - 无法安全映射时返回 undefined，让用户手工设置。
 */
export function reasoningEffortsOf(model: ModelsDevModel): PiAiModelEntry['reasoningEfforts'] {
	if (!model.reasoning) return false
	const option = model.reasoningOptions.find((candidate) => candidate.type === 'effort')
	if (!option || !Array.isArray(option.values)) return undefined
	const mapped: Record<string, string | null> = {}
	for (const raw of option.values) {
		if (typeof raw !== 'string') continue
		const value = raw.trim().toLowerCase()
		if (value === 'none' || value === 'off') mapped.off = null
		else if (EFFORT_LEVELS.has(value)) mapped[value] = value
	}
	return Object.keys(mapped).length > 0 ? mapped : undefined
}

/**
 * 把一个 models.dev 模型映射成官方格式的面板条目。
 * 不含价格等展示元数据；`inheritEntry` 为 true 时省略本可继承的字段。
 */
export function modelToEntry(model: ModelsDevModel, inheritEntry = false): PiAiModelEntry {
	const entry: PiAiModelEntry = { id: model.id }
	if (model.name && model.name !== model.id) entry.name = model.name
	if (model.limit.context !== undefined) entry.contextWindow = model.limit.context
	if (model.limit.output !== undefined) entry.maxTokens = model.limit.output
	const input = inputModalities(model)
	if (input.length > 0) entry.input = input
	if (!inheritEntry) {
		const efforts = reasoningEffortsOf(model)
		if (efforts !== undefined) entry.reasoningEfforts = efforts
	}
	return entry
}

/** 一个已发现模型（llm/discoverModels 的返回）→ 面板条目。 */
export function discoveredToEntry(model: {
	id: string
	name?: string
	contextWindow?: number
	maxTokens?: number
}): PiAiModelEntry {
	const entry: PiAiModelEntry = { id: model.id }
	if (model.name && model.name !== model.id) entry.name = model.name
	if (model.contextWindow !== undefined) entry.contextWindow = model.contextWindow
	if (model.maxTokens !== undefined) entry.maxTokens = model.maxTokens
	return entry
}

/** Provider 创建方案。 */
export type ProviderCreation =
	{ kind: 'custom'; profile: Record<string, unknown> } | { kind: 'unsupported'; reason: string }

/**
 * 规划一个 models.dev provider 的新建方式（导入只新建 Provider，没有目录继承）。
 * - openai-compatible / anthropic SDK：按其元数据写 api + baseURL。
 * - 其余 SDK 不能安全映射为 pi-ai 协议，交回用户。
 */
export function planProviderCreation(provider: ModelsDevProvider): ProviderCreation {
	if (!provider.api) {
		return {
			kind: 'unsupported',
			reason: 'models.dev 未提供 API Endpoint，且 pi-ai 没有该 Provider 的内置目录',
		}
	}
	if (provider.npm === '@ai-sdk/openai-compatible') {
		return {
			kind: 'custom',
			profile: { displayName: provider.name, api: 'openai-completions', baseURL: provider.api },
		}
	}
	if (provider.npm === '@ai-sdk/anthropic') {
		return {
			kind: 'custom',
			profile: { displayName: provider.name, api: 'anthropic-messages', baseURL: provider.api },
		}
	}
	return {
		kind: 'unsupported',
		reason: `无法把 ${provider.npm ?? '未知 SDK'} 安全映射为 pi-ai 协议`,
	}
}
