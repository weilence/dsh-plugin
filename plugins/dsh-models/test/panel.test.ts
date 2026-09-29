import { describe, expect, it } from 'vitest'
import { FALLBACK_CHOICES, readChoices } from '../src/pi-ai/choices'
import { buildRoutes } from '../src/pi-ai/view'
import { validateApiKey, deriveKeyRef } from '../src/client/operations'

/** 一段与官方 serialized schema 同形的 Schemastery envelope 片段。 */
const schemaEnvelope = {
  type: 'object',
  dict: {
    providers: {
      type: 'dict',
      inner: {
        type: 'object',
        dict: {
          api: {
            type: 'union',
            list: [
              { type: 'const', value: 'openai-completions' },
              { type: 'const', value: 'openai-responses' },
              { type: 'const', value: 'anthropic-messages' },
            ],
          },
          reasoning: {
            type: 'union',
            list: [
              { type: 'const', value: 'off' },
              { type: 'const', value: 'low' },
              { type: 'const', value: 'high' },
              { type: 'const', value: 'max' },
            ],
          },
          defaultInput: {
            type: 'array',
            inner: {
              type: 'union',
              list: [
                { type: 'const', value: 'text' },
                { type: 'const', value: 'image' },
              ],
            },
          },
          compat: {
            type: 'object',
            dict: {
              thinkingFormat: {
                type: 'union',
                list: [
                  { type: 'const', value: 'openai' },
                  { type: 'const', value: 'deepseek' },
                ],
              },
            },
          },
        },
      },
    },
  },
}

describe('官方 schema 选项内省', () => {
  it('从 namespace schema envelope 读出协议、推理等级、模态与 thinkingFormat', () => {
    const choices = readChoices(schemaEnvelope)
    expect(choices.protocols).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
    expect(choices.thinkingLevels).toEqual(['off', 'low', 'high', 'max'])
    expect(choices.modalities).toEqual(['text', 'image'])
    expect(choices.thinkingFormats).toEqual(['openai', 'deepseek'])
  })

  it('schema 形状不符时逐项回退，不抛异常', () => {
    expect(readChoices(undefined)).toEqual(FALLBACK_CHOICES)
    expect(readChoices({ type: 'object', dict: {} })).toEqual(FALLBACK_CHOICES)
  })
})

describe('面板行合成', () => {
  it('目录 route 折叠目录事实 + 用户 override + 生效接口', () => {
    const rows = buildRoutes(
      {
        user: {
          providers: { anthropic: { modelOverrides: { 'claude-x': { reasoningEfforts: { low: 'low' } } } } },
        },
        value: { providers: { anthropic: { displayName: 'Anthropic', defaultContextWindow: 16384 } } },
        base: {},
      },
      [{ provider: 'anthropic', displayName: 'Anthropic', declared: false, active: true }],
      new Map([
        ['anthropic', new Map([['claude-x', { name: 'Claude X', contextWindow: 1000, maxTokens: 100 }]])],
      ]),
      new Map([
        [
          'anthropic',
          new Map([
            [
              'claude-x',
              {
                id: 'claude-x',
                name: 'Claude X',
                inputModalities: ['text', 'image'],
                contextWindow: 1000,
                defaultMaxTokens: 100,
                reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
              },
            ],
          ]),
        ],
      ]),
    )
    expect(rows).toHaveLength(1)
    const route = rows[0]!
    expect(route.source).toBe('overridden')
    expect(route.rows[0]?.effectiveInput).toEqual(['text', 'image'])
    expect(route.rows[0]?.effectiveEfforts).toEqual(['low'])
    expect(route.rows[0]?.effectiveDefaultEffort).toBe('low')
  })

  it('显式清单 row 只来自用户层 models', () => {
    const rows = buildRoutes(
      { user: { providers: { gateway: { models: [{ id: 'a' }] } } }, value: {}, base: {} },
      [{ provider: 'gateway', displayName: 'Gateway', declared: true, active: true }],
      new Map(),
      new Map(),
    )
    expect(rows[0]?.source).toBe('declared')
    expect(rows[0]?.rows.map((row) => row.id)).toEqual(['a'])
  })
})

describe('API Key 处理', () => {
  it('派生 <ROUTE>_API_KEY 引用', () => {
    expect(deriveKeyRef('minimax-cn')).toBe('MINIMAX_CN_API_KEY')
    expect(deriveKeyRef('my.gateway')).toBe('MY_GATEWAY_API_KEY')
  })

  it('拒绝空、非 ASCII 与环境变量赋值形态', () => {
    expect(validateApiKey('')).toBeDefined()
    expect(validateApiKey('中文密钥')).toBeDefined()
    expect(validateApiKey('OPENAI_API_KEY=sk-1')).toBeDefined()
    expect(validateApiKey('sk-abc_123')).toBeUndefined()
  })
})
