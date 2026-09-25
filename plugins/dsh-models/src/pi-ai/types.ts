// 官方 @deepseek-ai/dsh-llm-pi-ai 配置面的本地镜像（仅类型）。
//
// 真源在 `dsh-llm-pi-ai/lib/types/config.d.ts`（PiAiProviderProfile、
// PiAiModelProfile、PiAiReasoningEfforts）与 `catalog.d.ts`（PiAiCompatProfile、
// PiAiModality）。这里不复制 compat 的完整字段表——那需要同时复制它的
// drift-gate 编译期约束，复制体一旦漂移就是静默错误；面板改为从 settings
// namespace 的 schema envelope 里内省选项（见 choices.ts），字段本身仍以
// 官方 JSON schema 为准。
//
// 本文件只声明面板自己构造与校验的字段，其余字段以 unknown 保留。

/** 面板可编辑的模型能力字段；其余官方字段原样保留。 */
export interface PiAiModelEntry {
	/** 请求时传给 provider 的模型 id。 */
	id: string
	/** 选择器显示名；缺省回退目录名、再回退 id。 */
	name?: string
	/** 输入 + 输出上下文总容量（正整数）。 */
	contextWindow?: number
	/** 输出能力；显式配置后同时成为该模型每次请求的默认输出上限。 */
	maxTokens?: number
	/** 请求模态；缺省或空数组都等于「继承下一层」，不是「不接受任何输入」。 */
	input?: readonly PiAiModality[]
	/** 可选推理等级 → 该等级的 wire 拼写；false 声明非推理模型。 */
	reasoningEfforts?: false | PiAiReasoningEfforts
	/** 模型级协议兼容开关；其协议不支持的字段会被 Host 拒绝。 */
	compat?: Readonly<Record<string, unknown>>
	/** 面板未编辑的官方字段（samplingParams 等）。 */
	[key: string]: unknown
}

/** 一个 pi-ai 模型可声明的请求模态（官方取值全集）。 */
export type PiAiModality = 'text' | 'image'

/** 官方 ModelThinkingLevel 全集，按升序排列。 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 一个推理等级。 */
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

/**
 * 官方 PiAiReasoningEfforts：键是模型提供的等级，值是该等级过线的拼写。
 * 只有 `off` 可以留空（表示「支持，但不发送参数」）；其余等级必须给出
 * 非空 wire 值。未出现在字典里的等级即「不提供」。
 */
export type PiAiReasoningEfforts = Partial<Record<ThinkingLevel, string | null>>

/** 面板可编辑的 Provider 字段；其余官方字段原样保留。 */
export interface PiAiProviderEntry {
	displayName?: string
	api?: string
	baseURL?: string
	models?: readonly PiAiModelEntry[]
	modelOverrides?: Readonly<Record<string, PiAiModelEntry>>
	compat?: Readonly<Record<string, unknown>>
	apiKeyEnv?: string
	[key: string]: unknown
}

/** 一个 route 面板可见的来源状态。 */
export type RouteSource =
	/** 安装目录 route，用户层未声明模型 → 单模型编辑写 modelOverrides。 */
	| 'inherited'
	/** 安装目录 route，用户层有 modelOverrides → 单模型编辑写 modelOverrides。 */
	| 'overridden'
	/** 用户层有非空 models → 整表编辑。 */
	| 'explicit'
	/** pi-ai 不提供的 route，必须自带 api/baseURL/models。 */
	| 'declared'
