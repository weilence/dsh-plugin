// 官方配置面的选项内省。
//
// 协议、reasoning 等级、thinkingFormat、模态这些选项刻意不硬编码：它们从
// settings namespace 序列化的 schema envelope（`Schema.toJSON()`）里读，
// 与 Host 校验用的是同一份 schema，所以永远不会有「面板提供了 Host 不认的
// 值」这种漂移。做法与官方 Models 页的 protocolChoices() 相同。
//
// 内省的 schema 形状（Schemastery）：
//   - object: { type:'object', dict: { <key>: node } }
//   - dict:   { type:'dict', inner: node }
//   - array:  { type:'array', inner: node }
//   - union:  { type:'union', list: [node, ...] }
//   - 常量:    { type:'const', value }
//
// 取 `providers` 下的任意键（官方 schema 用 dict 描述 providers，路径上的
// 具体 route 名无关紧要）——遍历 dict 时直接进入 inner。

import { THINKING_LEVELS, type PiAiModality, type ThinkingLevel } from './types'

/** Schemastery 序列化节点的最小结构；只声明本文件用到的部分。 */
interface SchemaNodeLike {
	type?: string
	dict?: Record<string, SchemaNodeLike>
	inner?: SchemaNodeLike
	list?: SchemaNodeLike[]
	value?: unknown
	meta?: { default?: unknown }
}

/** 面板需要从官方 schema 读出的全部选项。 */
export interface PiAiChoices {
	/** 可写入 `api` 的协议标识（顺序即官方顺序，首个是推荐默认）。 */
	protocols: readonly string[]
	/** 可选推理等级（官方 THINKING_LEVELS 顺序）。 */
	thinkingLevels: readonly ThinkingLevel[]
	/** 可选 `compat.thinkingFormat` 值。 */
	thinkingFormats: readonly string[]
	/** 可选请求模态。 */
	modalities: readonly PiAiModality[]
}

/** 官方 schema 无法内省时的保守回退（与 0.1.5-rc.2 的取值一致）。 */
export const FALLBACK_CHOICES: PiAiChoices = {
	protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
	thinkingLevels: THINKING_LEVELS,
	thinkingFormats: [
		'openai',
		'deepseek',
		'openrouter',
		'together',
		'baseten',
		'zai',
		'qwen',
		'chat-template',
		'qwen-chat-template',
		'string-thinking',
		'ant-ling',
	],
	modalities: ['text', 'image'],
}

function isNode(value: unknown): value is SchemaNodeLike {
	return typeof value === 'object' && value !== null
}

/** 沿 object / dict / array 路径下钻；路径上的 dict 键由调用方给出。 */
function nodeAt(root: unknown, path: readonly string[]): SchemaNodeLike | undefined {
	let node: unknown = root
	for (const key of path) {
		if (!isNode(node)) return undefined
		if (node.type === 'object') node = node.dict?.[key]
		else if (node.type === 'dict' || node.type === 'array') node = node.inner
		else return undefined
	}
	return isNode(node) ? node : undefined
}

/** 读一个 union 节点里的字符串常量；array 节点取它的 inner union。 */
function unionStrings(node: SchemaNodeLike | undefined): string[] {
	const target = node?.type === 'array' ? node.inner : node
	if (target?.type !== 'union' || !Array.isArray(target.list)) return []
	return target.list.flatMap((entry) =>
		entry?.type === 'const' && typeof entry.value === 'string' ? [entry.value] : [],
	)
}

/** 该 route 的 profile schema 节点（providers 是 dict，直接进 inner）。 */
function profileNode(root: unknown): SchemaNodeLike | undefined {
	const providers = nodeAt(root, ['providers'])
	if (providers?.type !== 'dict') return undefined
	return isNode(providers.inner) ? providers.inner : undefined
}

/**
 * 从 llm-pi-ai namespace 的 schema envelope 读出面板选项。
 * schema 形状不符合预期时逐项回退到 FALLBACK_CHOICES 的对应项。
 */
export function readChoices(serializedSchema: unknown): PiAiChoices {
	const profile = profileNode(serializedSchema)
	if (profile === undefined) return FALLBACK_CHOICES
	const protocols = unionStrings(nodeAt(profile, ['api']))
	const thinkingLevels = unionStrings(nodeAt(profile, ['reasoning'])).filter(
		(level): level is ThinkingLevel => (THINKING_LEVELS as readonly string[]).includes(level),
	)
	const thinkingFormats = unionStrings(nodeAt(profile, ['compat', 'thinkingFormat']))
	// 模态/推理等级在 schema 里是 array，union 藏在 array 的 inner，由 unionStrings 处理。
	const modalities = unionStrings(nodeAt(profile, ['defaultInput'])).filter(
		(value): value is PiAiModality => value === 'text' || value === 'image',
	)
	return {
		protocols: protocols.length > 0 ? protocols : FALLBACK_CHOICES.protocols,
		thinkingLevels: thinkingLevels.length > 0 ? thinkingLevels : FALLBACK_CHOICES.thinkingLevels,
		thinkingFormats: thinkingFormats.length > 0 ? thinkingFormats : FALLBACK_CHOICES.thinkingFormats,
		modalities: modalities.length > 0 ? modalities : FALLBACK_CHOICES.modalities,
	}
}
