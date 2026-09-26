import { describe, expect, it } from 'vitest'
import { modelToEntry, planProviderCreation, reasoningEffortsOf } from '../src/catalog/map'
import { loadCatalog, parseCatalogWire, resetCatalogCacheForTest } from '../src/catalog/parse'
import type { ModelsDevModel, ModelsDevProvider } from '../src/catalog/types'

function model(patch: Partial<ModelsDevModel> = {}): ModelsDevModel {
  return {
    id: 'demo/model',
    name: 'Demo',
    reasoning: true,
    reasoningOptions: [{ type: 'effort', values: ['none', 'low', 'high'] }],
    toolCall: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 128000, output: 8192 },
    ...patch,
  }
}

describe('models.dev → 官方 PiAiModelProfile 映射', () => {
  it('只把 effort 值映射成官方 reasoningEfforts，none 归为 off: null', () => {
    expect(reasoningEffortsOf(model())).toEqual({ off: null, low: 'low', high: 'high' })
  })

  it('toggle / budget_tokens 不产生推理映射，非推理模型写 false', () => {
    expect(reasoningEffortsOf(model({ reasoningOptions: [{ type: 'toggle' }] }))).toBeUndefined()
    expect(
      reasoningEffortsOf(model({ reasoningOptions: [{ type: 'budget_tokens', min: 1024 }] })),
    ).toBeUndefined()
    expect(reasoningEffortsOf(model({ reasoning: false }))).toBe(false)
  })

  it('模态只保留 text/image，contextWindow/maxTokens 按官方字段名输出', () => {
    const entry = modelToEntry(
      model({ modalities: { input: ['text', 'image', 'pdf', 'video'], output: ['text'] } }),
    )
    expect(entry).toEqual({
      id: 'demo/model',
      name: 'Demo',
      contextWindow: 128000,
      maxTokens: 8192,
      input: ['text', 'image'],
      reasoningEfforts: { off: null, low: 'low', high: 'high' },
    })
  })

  it('标题与 id 相同时不重复写 name；id 与 name 相同时省略', () => {
    expect(modelToEntry(model({ id: 'same', name: 'same' }))).not.toHaveProperty('name')
  })

  it('不写价格等展示元数据', () => {
    const entry = modelToEntry(model())
    for (const key of ['cost', 'release_date', 'knowledge', 'attachment', 'structured_output']) {
      expect(entry).not.toHaveProperty(key)
    }
  })
})

describe('Provider 创建规划', () => {
  const provider: ModelsDevProvider = {
    id: 'demo',
    name: 'Demo Provider',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.example.com/v1',
    env: ['DEMO_API_KEY'],
    models: [],
  }

  it('openai-compatible / anthropic 映射成官方 api + baseURL', () => {
    expect(planProviderCreation(provider)).toEqual({
      kind: 'custom',
      profile: {
        displayName: 'Demo Provider',
        api: 'openai-completions',
        baseURL: 'https://api.example.com/v1',
      },
    })
    expect(planProviderCreation({ ...provider, npm: '@ai-sdk/anthropic' })).toMatchObject({
      profile: { api: 'anthropic-messages' },
    })
  })

  it('缺少 Endpoint 或无法识别的 SDK 不盲目创建', () => {
    expect(planProviderCreation({ ...provider, api: undefined })).toMatchObject({
      kind: 'unsupported',
    })
    expect(planProviderCreation({ ...provider, npm: '@ai-sdk/azure' })).toMatchObject({
      kind: 'unsupported',
    })
  })
})

describe('目录解析与 ETag 缓存', () => {
  it('解析 Provider/模型并按名称排序', () => {
    const catalog = parseCatalogWire(
      {
        z: {
          id: 'z',
          name: 'Zulu',
          env: ['Z_KEY'],
          models: { b: { id: 'b', name: 'Beta', modalities: {} } },
        },
        a: { id: 'a', name: 'Alpha', models: { a: { id: 'a', name: 'Alpha Model', modalities: {} } } },
      },
      { etag: '"v1"' },
    )
    expect(catalog.providers.map((item) => item.id)).toEqual(['a', 'z'])
    expect(catalog.etag).toBe('"v1"')
  })

  it('收到 304 时复用已解析目录', async () => {
    let calls = 0
    const fetchMock = async (_url: string, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        return new Response(
          JSON.stringify({
            demo: { id: 'demo', name: 'Demo', models: { m: { id: 'm', name: 'M', modalities: {} } } },
          }),
          {
            status: 200,
            headers: { etag: '"v1"' },
          },
        )
      }
      expect(new Headers(init?.headers).get('if-none-match')).toBe('"v1"')
      return new Response(null, { status: 304 })
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch
    try {
      const first = await loadCatalog(false)
      const second = await loadCatalog(false)
      expect(second.providers[0]?.id).toBe('demo')
      expect(second.etag).toBe(first.etag)
    } finally {
      globalThis.fetch = originalFetch
      resetCatalogCacheForTest()
    }
  })
})
