import { discoveredToEntry, modelToEntry } from './map'
import type { DiscoveredModel, ModelsDevCatalog, ModelsDevModel, ModelsDevProvider } from './types'
import type { PiAiModelEntry } from '../pi-ai/types'

type Preference = { pattern: RegExp; providerIds: string[]; names?: string[]; api?: string[] }
const PREFERENCES: Preference[] = [
	{ pattern: /^gpt-(?!oss(?:-|$))|^o[134](?:-|$)/, providerIds: ['openai'] },
	{ pattern: /^claude-/, providerIds: ['anthropic'] },
	{ pattern: /^glm-/, providerIds: ['zai', 'z-ai'], names: ['z.ai', 'z ai'], api: ['api.z.ai'] },
	{ pattern: /^deepseek-/, providerIds: ['deepseek'] },
	{ pattern: /^gemini-/, providerIds: ['google', 'google-ai'] },
	{
		pattern: /^qwen(?:-|\/|\d)/,
		providerIds: ['alibaba', 'alibaba-cloud', 'dashscope', 'qwen'],
		names: ['alibaba cloud', 'dashscope'],
		api: ['dashscope.aliyuncs.com'],
	},
	{
		pattern: /^(?:kimi-|moonshot-)/,
		providerIds: ['moonshot', 'moonshotai'],
		names: ['moonshot ai'],
		api: ['api.moonshot.cn'],
	},
	{ pattern: /^doubao-/, providerIds: ['volcengine', 'volcengine-ark', 'ark'], names: ['volcengine'] },
	{ pattern: /^minimax-/, providerIds: ['minimax'] },
	{ pattern: /^grok-/, providerIds: ['xai', 'x-ai'] },
	{ pattern: /^(?:mistral-|codestral-|pixtral-)/, providerIds: ['mistral'] },
	{ pattern: /^command(?:-|$)/, providerIds: ['cohere'] },
	{ pattern: /^ernie-/, providerIds: ['baidu', 'baidu-qianfan', 'qianfan'], names: ['baidu'] },
	{ pattern: /^hunyuan-/, providerIds: ['tencent', 'tencent-cloud', 'hunyuan'], names: ['tencent cloud'] },
	{ pattern: /^step-/, providerIds: ['stepfun', 'step-fun'], names: ['stepfun'] },
]
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '')

function providerById(catalog: ModelsDevCatalog, id: string) {
	return catalog.providers.find((provider) => normalize(provider.id) === normalize(id))
}
function providerByPreference(catalog: ModelsDevCatalog, preference: Preference) {
	const ids = new Set(preference.providerIds.map(normalize))
	const names = new Set((preference.names ?? []).map(normalize))
	return catalog.providers.find(
		(provider) =>
			ids.has(normalize(provider.id)) ||
			names.has(normalize(provider.name)) ||
			(preference.api ?? []).some((fragment) => provider.api?.toLowerCase().includes(fragment)),
	)
}
function preferenceFor(id: string) {
	return PREFERENCES.find((preference) => preference.pattern.test(id.trim().toLowerCase()))
}

function exactModel(provider: ModelsDevProvider | undefined, id: string): ModelsDevModel | undefined {
	return provider?.models.find((model) => model.id.toLowerCase() === id.toLowerCase())
}

/**
 * Endpoint 偶尔在目录模型 ID 后附加 -xxxx。只考虑同一 Provider 中完整模型 ID
 * 后接连字符的候选，并取最长的已知 ID；不把不同模型或纯前缀误判成同一个。
 */
function suffixedModel(provider: ModelsDevProvider | undefined, id: string): ModelsDevModel | undefined {
	const lowerId = id.toLowerCase()
	return provider?.models.reduce<ModelsDevModel | undefined>((longest, model) => {
		const key = model.id.toLowerCase()
		if (!lowerId.startsWith(`${key}-`)) return longest
		return longest === undefined || key.length > longest.id.length ? model : longest
	}, undefined)
}

/**
 * 元数据匹配优先级：
 * ① Endpoint 能在目录里定位到 Provider 时，只在该 Provider 内按 ID **完全相等**
 *   匹配——网关常在目录 ID 后追加自有尾缀，尾缀推断只对厂商自己的目录可信；
 * ② ①未命中（或 Endpoint 没有对应 Provider）时，按模型 ID 前缀定位已知厂商
 *   Provider：先 ID 完全相等，再已知 ID + 「-尾缀」（多个候选取最长）。
 * ①②都未命中时，{@link discoveredToCatalogEntry} 还会用 {@link crossCatalogEntry}
 * 做第③层全目录兜底。
 */
export function findModelMetadata(catalog: ModelsDevCatalog | null, id: string, fallbackProviderId?: string) {
	if (!catalog) return undefined
	const endpoint = fallbackProviderId ? providerById(catalog, fallbackProviderId) : undefined
	const endpointExact = endpoint ? exactModel(endpoint, id) : undefined
	if (endpoint && endpointExact) return { provider: endpoint, model: endpointExact }
	const preference = preferenceFor(id)
	const preferred = preference ? providerByPreference(catalog, preference) : undefined
	if (preferred) {
		const model = exactModel(preferred, id) ?? suffixedModel(preferred, id)
		if (model) return { provider: preferred, model }
	}
	return undefined
}

/**
 * 多数派取值：按 JSON 形态分组计数。票数不同取最多；同票数时 undefined
 * 让位于有值者、数值按比较器取胜者、其余保持先出现者。
 */
function majorityOf<T>(values: readonly (T | undefined)[], tieBreak?: (a: T, b: T) => number): T | undefined {
	const groups = new Map<string, { value: T | undefined; count: number }>()
	for (const value of values) {
		const key = JSON.stringify(value) ?? '∅'
		const group = groups.get(key)
		if (group) group.count += 1
		else groups.set(key, { value, count: 1 })
	}
	let best: { value: T | undefined; count: number } | undefined
	for (const group of groups.values()) {
		if (best === undefined || group.count > best.count) {
			best = group
			continue
		}
		if (group.count < best.count) continue
		if (best.value === undefined) best = group
		else if (group.value !== undefined && tieBreak !== undefined && tieBreak(group.value, best.value) > 0) {
			best = group
		}
	}
	return best === undefined ? undefined : best.value
}

/**
 * 第③层兜底：①②都未命中时，把「ID 完全相等 → 已知 ID + 「-尾缀」」扩展到
 * 全目录 Provider。同一基础 ID 常被多家网关收录而容量略有出入，逐字段取
 * 出现次数最多的值（contextWindow / maxTokens 同票数取较大值）；没有命中
 * 返回 undefined。
 */
export function crossCatalogEntry(
	catalog: ModelsDevCatalog | null,
	id: string,
): Partial<PiAiModelEntry> | undefined {
	if (!catalog) return undefined
	const lowerId = id.toLowerCase()
	let family: ModelsDevModel[] = []
	for (const provider of catalog.providers) {
		for (const model of provider.models) {
			if (model.id.toLowerCase() === lowerId) family.push(model)
		}
	}
	if (family.length === 0) {
		let longest = -1
		for (const provider of catalog.providers) {
			for (const model of provider.models) {
				const key = model.id.toLowerCase()
				if (!lowerId.startsWith(`${key}-`)) continue
				if (key.length > longest) {
					longest = key.length
					family = [model]
				} else if (key.length === longest) {
					family.push(model)
				}
			}
		}
	}
	if (family.length === 0) return undefined
	const entries = family.map((model) => modelToEntry(model))
	const entry: Partial<PiAiModelEntry> = {}
	const name = majorityOf(entries.map((item) => item.name))
	if (name !== undefined) entry.name = name
	const contextWindow = majorityOf(
		entries.map((item) => item.contextWindow),
		(a, b) => a - b,
	)
	if (contextWindow !== undefined) entry.contextWindow = contextWindow
	const maxTokens = majorityOf(
		entries.map((item) => item.maxTokens),
		(a, b) => a - b,
	)
	if (maxTokens !== undefined) entry.maxTokens = maxTokens
	const input = majorityOf(entries.map((item) => item.input))
	if (input !== undefined) entry.input = input
	const efforts = majorityOf(entries.map((item) => item.reasoningEfforts))
	if (efforts !== undefined) entry.reasoningEfforts = efforts
	return entry
}

/**
 * Merge endpoint facts with catalog metadata, preserving the endpoint model ID.
 * 匹配顺序：① Endpoint Provider 精确 → ② 已知厂商（精确 → -尾缀）→
 * ③ 全目录兜底（精确 → -尾缀，多数派容量）。目录没有对应项时保留 Endpoint 返回值。
 */
export function discoveredToCatalogEntry(
	catalog: ModelsDevCatalog | null,
	model: DiscoveredModel,
	fallbackProviderId?: string,
): PiAiModelEntry {
	const discovered = discoveredToEntry(model)
	const metadata = findModelMetadata(catalog, model.id, fallbackProviderId)
	if (metadata) return { ...discovered, ...modelToEntry(metadata.model), id: model.id }
	const family = crossCatalogEntry(catalog, model.id)
	if (family) return { ...discovered, ...family, id: model.id }
	return discovered
}
