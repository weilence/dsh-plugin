import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { effectiveModelsFor, writeEffectiveJson } from '../src/effective'
import { readEffectiveProvider } from '../src/index'

/** 只读桥消费的 llm 面（官方 LlmRuntime 的结构子集）。 */
function llmStub(overrides: {
  listModels?: (provider: string) => Promise<readonly { provider: string; id: string; name: string }[]>
  resolveModelInfo?: (provider: string, model: string) => Promise<unknown>
}): Context {
  return { llm: overrides } as unknown as Context
}

describe('生效能力只读桥', () => {
  it('把 resolveModelInfo 的模态、容量、默认档映射成回包形状', async () => {
    const ctx = llmStub({
      listModels: async () => [
        { provider: 'anthropic', id: 'a', name: 'A' },
        { provider: 'anthropic', id: 'b', name: 'B' },
      ],
      resolveModelInfo: async (_provider, model) =>
        model === 'a'
          ? {
              provider: 'anthropic',
              id: 'a',
              name: 'A',
              inputModalities: ['text', 'image'],
              context: { contextWindow: 1_000_000 },
              defaultMaxTokens: 128_000,
              reasoning: {
                efforts: [
                  { id: 'low', name: 'Low' },
                  { id: 'high', name: 'High' },
                ],
                defaultEffort: 'high',
              },
            }
          : { provider: 'anthropic', id: 'b', name: 'B' },
    })
    const outcome = await effectiveModelsFor(ctx, 'anthropic')
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.models).toEqual([
      {
        id: 'a',
        name: 'A',
        inputModalities: ['text', 'image'],
        contextWindow: 1_000_000,
        defaultMaxTokens: 128_000,
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      },
      // 缺省字段一律不出现在回包里：客户端据此区分「未知」与「没有」。
      { id: 'b', name: 'B' },
    ])
  })

  it('单个模型解析失败只跳过该模型，不影响其余能力', async () => {
    const ctx = llmStub({
      listModels: async () => [
        { provider: 'p', id: 'broken', name: 'Broken' },
        { provider: 'p', id: 'fine', name: 'Fine' },
      ],
      resolveModelInfo: async (_provider, model) => {
        if (model === 'broken') throw new Error('stored catalog drift')
        return { provider: 'p', id: 'fine', name: 'Fine', context: { contextWindow: 100 } }
      },
    })
    const outcome = await effectiveModelsFor(ctx, 'p')
    expect(outcome.kind).toBe('ok')
    if (outcome.kind !== 'ok') return
    expect(outcome.models.map((model) => model.id)).toEqual(['fine'])
  })

  it('route 完全没有注册时返回明确原因，而不是抛给 HTTP 层', async () => {
    const ctx = llmStub({
      listModels: async () => {
        throw new Error('pi-ai provider "ghost" has no configured model')
      },
    })
    await expect(effectiveModelsFor(ctx, 'ghost')).resolves.toMatchObject({ kind: 'unavailable' })
  })

  it('provider 查询参数缺失/空白都视为未给出', () => {
    const req = (url: string) => ({ url }) as never
    expect(readEffectiveProvider(req('/dsh-models/effective-models?provider=anthropic'))).toBe('anthropic')
    expect(readEffectiveProvider(req('/dsh-models/effective-models?provider=%20%20'))).toBeUndefined()
    expect(readEffectiveProvider(req('/dsh-models/effective-models'))).toBeUndefined()
  })

  it('回包统一 no-store JSON', () => {
    const headers: Record<string, string> = {}
    const res = {
      writeHead(_status: number, h: Record<string, string>) {
        Object.assign(headers, h)
      },
      end() {},
    }
    writeEffectiveJson(res as never, 200, { models: [] })
    expect(headers['content-type']).toContain('application/json')
    expect(headers['cache-control']).toBe('no-store')
  })
})
