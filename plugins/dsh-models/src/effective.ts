// Host 只读桥：某个 route 当前真正生效的模型能力。
//
// 为什么需要它：安装目录 route 只写 `modelOverrides` 时，客户端手里的
// settings 文本并不知道目录里每个模型的模态 / 容量 / 推理档——目录由 pi-ai
// 提供，而 `llm/discoverModels` 只回 id/name/contextWindow/maxTokens。
// 要如实显示「继承目录能力」的结果，就得问真正做了合并的适配器：
// `ctx.llm.resolveModelInfo(provider, model)` 返回的正是会话模型选择器看到的
// 那份 `LlmResolvedModelInfo`（模态、上下文、默认输出上限、可选推理档与默认档）。
//
// 本模块只读：不写 settings、不解析配置，也不缓存——每次请求都问适配器当前
// 快照，因此与请求路径看到的能力永远一致。模型列表来自同一 route 的活动
// registration（`resolveModelInfo` 只对已配置模型有效）。

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { ServerResponse } from 'node:http'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm/types'

/** 本桥回答的一条模型能力。 */
export interface EffectiveModelBody {
	id: string
	name: string
	/** 目录/配置声明的请求模态。 */
	inputModalities?: readonly string[]
	/** 上下文容量。 */
	contextWindow?: number
	/** 适配器配置的每次请求默认输出上限（仅显式配置时存在）。 */
	defaultMaxTokens?: number
	/** 可选推理档与配置的默认档。 */
	reasoning?: {
		efforts: readonly { id: string; name: string }[]
		defaultEffort?: string
	}
}

function toBody(info: LlmResolvedModelInfo): EffectiveModelBody {
	return {
		id: info.id,
		name: info.name,
		...(info.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] }),
		...(info.context === undefined ? {} : { contextWindow: info.context.contextWindow }),
		...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
		...(info.reasoning === undefined
			? {}
			: {
					reasoning: {
						efforts: info.reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name })),
						...(info.reasoning.defaultEffort === undefined
							? {}
							: { defaultEffort: info.reasoning.defaultEffort }),
					},
				}),
	}
}

/** 一次查询的结果。 */
export type EffectiveResult =
	{ kind: 'ok'; models: readonly EffectiveModelBody[] } | { kind: 'unavailable'; message: string }

/**
 * 查询一个 route 的生效能力。
 *
 * 先 listModels（advisory，可能为空），再逐个 resolveModelInfo；单个模型
 * 解析失败（例如存储的目录漂移）只跳过该模型，不使整个查询失败——面板仍
 * 应显示其余可用模型的能力。
 *
 * @param ctx host 上下文（需已挂载 llm 服务）。
 * @param provider route id。
 * @returns 生效能力列表，或明确不可用的原因。
 */
export async function effectiveModelsFor(ctx: Context, provider: string): Promise<EffectiveResult> {
	try {
		const listed = await ctx.llm.listModels(provider)
		const models: EffectiveModelBody[] = []
		for (const model of listed) {
			try {
				models.push(toBody(await ctx.llm.resolveModelInfo(provider, model.id)))
			} catch {
				// 该模型当前无法解析（目录漂移等）；能力未知，跳过。
			}
		}
		return { kind: 'ok', models }
	} catch (error) {
		const message = (error as { message?: string } | null | undefined)?.message ?? String(error)
		return { kind: 'unavailable', message }
	}
}

/** 统一的 JSON 回包。 */
export function writeEffectiveJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
	const payload = Buffer.from(JSON.stringify(body))
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(payload.byteLength),
		'cache-control': 'no-store',
	})
	res.end(payload)
}
