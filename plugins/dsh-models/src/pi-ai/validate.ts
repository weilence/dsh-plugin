// reasoningEfforts 与模型能力的官方规则校验。
//
// 真源：`dsh-llm-pi-ai/lib/index.js` 的 resolveModelReasoning() 与
// modelFields/ profile schema。下面是它会在 settings 写入时抛出的每一条
// 拒绝理由，前移到面板做即时反馈；Host 校验仍然是最终裁决，本文件只负责
// 让用户在按下「保存」之前就看到同一个结论。
//
// 规则（逐条对应官方实现）：
//   1. 省略 reasoningEfforts = 继承安装目录能力（手工 route 等于无推理）。
//   2. false = 显式声明非推理模型。
//   3. 非空字典；空对象非法。
//   4. 键必须在 THINKING_LEVELS 内。
//   5. 非 off 等级的值必须是非空字符串；off 可以为 null。
//   6. 除 off 外必须至少声明一个等级。

import { THINKING_LEVELS, type PiAiModality, type PiAiReasoningEfforts, type ThinkingLevel } from './types'

const LEVEL_SET = new Set<string>(THINKING_LEVELS)
const MODALITY_SET = new Set<string>(['text', 'image'])

/** 一个字段级校验结论。 */
export interface FieldIssue {
	/** 出错字段的路径（例如 `reasoningEfforts.high`）。 */
	path: string
	message: string
}

/** 官方 off 之外的等级全集（需要非空 wire 值）。 */
const THINKING_LEVELS_WITHOUT_OFF = THINKING_LEVELS.filter((level) => level !== 'off')

export function isThinkingLevel(value: string): value is ThinkingLevel {
	return LEVEL_SET.has(value)
}

export function isModality(value: string): value is PiAiModality {
	return MODALITY_SET.has(value)
}

/**
 * 校验一份 reasoningEfforts，返回所有问题（空数组 = 合法）。
 * `undefined` 表示「继承」，`false` 表示「非推理模型」，两者都合法。
 */
export function validateReasoningEfforts(value: unknown): FieldIssue[] {
	if (value === undefined || value === false) return []
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return [{ path: 'reasoningEfforts', message: 'reasoningEfforts 必须是字典、false，或改回「显示设置」' }]
	}
	const issues: FieldIssue[] = []
	const entries = Object.entries(value as Record<string, unknown>)
	if (entries.length === 0) {
		return [
			{
				path: 'reasoningEfforts',
				message: 'reasoningEfforts 不能是空字典；声明提供的等级，改 false 表示非推理模型，或改回「显示设置」',
			},
		]
	}
	for (const [level, wire] of entries) {
		if (!isThinkingLevel(level)) {
			issues.push({
				path: `reasoningEfforts.${level}`,
				message: `未知推理等级「${level}」；可用等级为 ${THINKING_LEVELS.join(', ')}`,
			})
			continue
		}
		if (wire === null || wire === undefined) {
			if (level !== 'off') {
				issues.push({
					path: `reasoningEfforts.${level}`,
					message: `等级 ${level} 必须给出 dispatch 应发送的 wire 值；只有 off 可以留空`,
				})
			}
			continue
		}
		if (typeof wire !== 'string') {
			issues.push({ path: `reasoningEfforts.${level}`, message: `等级 ${level} 的 wire 值必须是字符串` })
			continue
		}
		if (wire.length === 0) {
			issues.push({ path: `reasoningEfforts.${level}`, message: `等级 ${level} 的 wire 值不能为空字符串` })
		}
	}
	if (!THINKING_LEVELS_WITHOUT_OFF.some((level) => Object.hasOwn(value, level))) {
		issues.push({
			path: 'reasoningEfforts',
			message: 'reasoningEfforts 只提供了 off；请声明至少一个思考等级，或改 false 表示非推理模型',
		})
	}
	return issues
}

/** 校验一个正整数字段（contextWindow / maxTokens）。 */
export function validatePositiveInteger(value: unknown, path: string): FieldIssue[] {
	if (value === undefined || value === null) return []
	const n = Number(value)
	if (!Number.isSafeInteger(n) || n <= 0) {
		return [{ path, message: `${path} 必须是正整数` }]
	}
	return []
}

/** 校验一份 input 模态列表；省略/空数组都表示「继承」，因此不报错。 */
export function validateInput(value: unknown): FieldIssue[] {
	if (value === undefined || value === null) return []
	if (!Array.isArray(value)) return [{ path: 'input', message: 'input 必须是模态数组（text / image）' }]
	const issues: FieldIssue[] = []
	for (const item of value) {
		if (typeof item !== 'string' || !isModality(item)) {
			issues.push({ path: 'input', message: `未知模态「${String(item)}」；可用值为 text、image` })
		}
	}
	if (new Set(value).size !== value.length) issues.push({ path: 'input', message: 'input 不能包含重复模态' })
	return issues
}

/** 面板对一个模型条目的完整字段级校验。 */
export function validateModelEntry(entry: {
	id: string
	name?: unknown
	contextWindow?: unknown
	maxTokens?: unknown
	input?: unknown
	reasoningEfforts?: unknown
}): FieldIssue[] {
	const issues: FieldIssue[] = []
	if (!entry.id || typeof entry.id !== 'string') issues.push({ path: 'id', message: '模型 id 不能为空' })
	if (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name.length === 0)) {
		issues.push({ path: 'name', message: '显示名不能为空；留空即回退目录名再回退 id' })
	}
	issues.push(...validatePositiveInteger(entry.contextWindow, 'contextWindow'))
	issues.push(...validatePositiveInteger(entry.maxTokens, 'maxTokens'))
	issues.push(...validateInput(entry.input))
	issues.push(...validateReasoningEfforts(entry.reasoningEfforts))
	return issues
}

/**
 * 把面板草稿的 reasoningEfforts 规整成官方可写形态：
 * - `undefined` 保持 undefined（继承）；
 * - `false` 保持 false；
 * - 其余按 THINKING_LEVELS 顺序重建，只保留非 undefined 的键。
 */
export function normalizeReasoningEfforts(
	value: false | Partial<Record<ThinkingLevel, string | null | undefined>> | undefined,
): false | PiAiReasoningEfforts | undefined {
	if (value === undefined || value === false) return value
	const result: PiAiReasoningEfforts = {}
	for (const level of THINKING_LEVELS) {
		if (!Object.hasOwn(value, level)) continue
		const wire = value[level]
		if (wire === undefined) continue
		result[level] = wire
	}
	return result
}
