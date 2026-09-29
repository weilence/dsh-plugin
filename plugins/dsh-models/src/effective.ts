import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm/types'
import { errMsg } from '@dsh-plugins/shared'

/** 只读桥回答的一条模型能力（client half 经 operations.ts 复用同一契约）。 */
export interface EffectiveModelFacts {
  id: string
  name: string
  inputModalities?: readonly string[]
  contextWindow?: number
  defaultMaxTokens?: number
  reasoning?: {
    efforts: readonly { id: string; name: string }[]
    defaultEffort?: string
  }
}

function toBody(info: LlmResolvedModelInfo): EffectiveModelFacts {
  return {
    id: info.id,
    name: info.name,
    inputModalities: info.inputModalities === undefined ? undefined : [...info.inputModalities],
    contextWindow: info.context === undefined ? undefined : info.context.contextWindow,
    defaultMaxTokens: info.defaultMaxTokens,
    reasoning:
      info.reasoning === undefined
        ? undefined
        : {
            efforts: info.reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name })),
            defaultEffort: info.reasoning.defaultEffort,
          },
  }
}

export type EffectiveResult =
  { kind: 'ok'; models: readonly EffectiveModelFacts[] } | { kind: 'unavailable'; message: string }

// 值逐个来自 ctx.llm.resolveModelInfo（会话模型选择器看到的同一份事实），
// 只读不缓存；模型列表来自同一 route 的活动 registration。
export async function effectiveModelsFor(ctx: Context, provider: string): Promise<EffectiveResult> {
  try {
    const listed = await ctx.llm.listModels(provider)
    const models: EffectiveModelFacts[] = []
    for (const model of listed) {
      try {
        models.push(toBody(await ctx.llm.resolveModelInfo(provider, model.id)))
      } catch {
        // 单模型解析失败属瞬态 catalog drift，不该让整条只读桥变 unavailable。
      }
    }
    return { kind: 'ok', models }
  } catch (error) {
    return { kind: 'unavailable', message: errMsg(error) }
  }
}
