// 面板草稿 → 官方可写形态的归一化。
//
// 目标是让生成的 settings.yaml 与官方 README 示例逐字段同形：只写用户真正
// 编辑过的字段，按官方字段顺序排列，去掉 undefined / 空值，避免把 schema
// 默认值物化进用户配置。

import type { PiAiModelEntry } from './types'
import { normalizeReasoningEfforts } from './validate'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function cloneJson<T>(value: T): T {
	return structuredClone(value)
}

/**
 * 归一化一个模型条目，且只保留官方 PiAiModelProfile 里面板能编辑的字段
 * 加上面板不认识的既有字段（保证「编辑器没展示的现有模型字段在编辑后仍会
 * 保留」，与官方 Models 页的取舍一致）。
 */
export function normalizeModelEntry(entry: PiAiModelEntry): PiAiModelEntry {
	const result: Record<string, unknown> = {}
	// 已知字段按官方顺序写入。
	if (entry.id) result.id = entry.id
	if (typeof entry.name === 'string' && entry.name.length > 0) result.name = entry.name
	if (entry.contextWindow !== undefined) result.contextWindow = entry.contextWindow
	if (entry.maxTokens !== undefined) result.maxTokens = entry.maxTokens
	if (Array.isArray(entry.input) && entry.input.length > 0) result.input = [...entry.input]
	const efforts = normalizeReasoningEfforts(entry.reasoningEfforts)
	if (efforts !== undefined) result.reasoningEfforts = efforts
	if (isRecord(entry.compat) && Object.keys(entry.compat).length > 0) result.compat = cloneJson(entry.compat)
	// 面板不编辑的官方字段原样保留（samplingParams 等）。
	for (const [key, value] of Object.entries(entry)) {
		if (key in result) continue
		if (value === undefined) continue
		result[key] = cloneJson(value)
	}
	return result as PiAiModelEntry
}
