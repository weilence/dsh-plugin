import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createZhipuSearchProvider, parseSearchResult } from '../src/search'

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  close: vi.fn(),
  transport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    connect = mocks.connect
    listTools = mocks.listTools
    callTool = mocks.callTool
    close = mocks.close
  },
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) {
      mocks.transport(url, options)
    }
  },
}))

const searchTool = {
  name: 'web_search_prime',
  inputSchema: {
    type: 'object',
    properties: { search_query: { type: 'string' } },
    required: ['search_query'],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.listTools.mockResolvedValue({ tools: [searchTool] })
  mocks.callTool.mockResolvedValue({ content: [{ type: 'text', text: '[]' }] })
  mocks.close.mockResolvedValue(undefined)
})

describe('智谱搜索结果解析', () => {
  it('映射 JSON 文本里的 link/title/content，空列表确认为无结果', () => {
    const source = { title: '标题', link: 'https://example.com/a', content: '摘要', refer: 'ref_1' }
    const list = JSON.stringify([source])
    // 实测：数组 JSON 被再包一层 JSON 字符串；单层裸数组也接受。
    for (const text of [JSON.stringify(list), list]) {
      expect(parseSearchResult({ content: [{ type: 'text', text }] })).toEqual({
        sources: [{ url: source.link, title: '标题', snippet: '摘要' }],
        truncated: false,
      })
    }
    expect(parseSearchResult({ content: [{ type: 'text', text: JSON.stringify('[]') }] }).sources).toEqual([])
  })

  it('文本数组优先于 structuredContent 包装对象，不把未知形状伪装成空结果', () => {
    // 实测形状：text 块是裸数组 JSON，structuredContent 是未公开的包装对象。
    const wrapped = parseSearchResult({
      structuredContent: { wrapped: true },
      content: [{ type: 'text', text: JSON.stringify([{ link: 'https://example.com' }]) }],
    })
    expect(wrapped.sources).toEqual([{ url: 'https://example.com/' }])
    // 文本不可解析时退回 structuredContent，仅当它直接是数组才采用。
    const fallback = parseSearchResult({
      structuredContent: [{ link: 'https://example.com' }],
      content: [{ type: 'text', text: '非 JSON 文本' }],
    })
    expect(fallback.sources).toEqual([{ url: 'https://example.com/' }])
    // 两者都不是数组：报错并携带实际形状。
    expect(() =>
      parseSearchResult({
        structuredContent: { searchResult: [] },
        content: [{ type: 'text', text: '非 JSON 文本' }],
      }),
    ).toThrow(/不是来源列表（文本 undefined，structuredContent 对象\(searchResult\)）/)
    expect(() => parseSearchResult({ content: [{ type: 'text', text: '{}' }] })).toThrow('不是来源列表')
    expect(() =>
      parseSearchResult({
        structuredContent: [{ link: 'https://example.com', content: 'a'.repeat(200_001) }],
        content: [],
      }),
    ).toThrow('超过大小限制')
    expect(() => parseSearchResult({ isError: true, content: [{ type: 'text', text: '配额不足' }] })).toThrow(
      '配额不足',
    )
  })

  it('拒绝无效、携带凭据以及非 HTTP(S) URL', () => {
    for (const url of [
      'not-a-url',
      'file:///etc/passwd',
      'https://user:secret@example.com/',
      ' https://example.com/',
      'https://example.com/a\n- [fake](https://attacker.example)',
    ]) {
      expect(() =>
        parseSearchResult({ content: [{ type: 'text', text: JSON.stringify([{ link: url }]) }] }),
      ).toThrow('URL')
    }
    expect(() => parseSearchResult({ content: [{ type: 'text', text: '[{}]' }] })).toThrow('缺少 URL')
  })

  it('将来源 URL 规范化，并阻止标题与摘要伪造引用', () => {
    const [source] = parseSearchResult({
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            {
              link: 'https://EXAMPLE.COM/a(b)',
              title: '新闻](https://fake.example)',
              content: '摘\n- [假来源](https://fake.example)',
            },
          ]),
        },
      ],
    }).sources
    expect(source).toEqual({
      url: 'https://example.com/a%28b%29',
      title: '新闻\\]\\(https://fake.example\\)',
      snippet: '摘 - \\[假来源\\]\\(https://fake.example\\)',
    })
  })
})

describe('智谱搜索提供者', () => {
  it('每次读取凭据、发现工具并传递取消信号，连接关闭后不保留状态', async () => {
    const resolveKey = vi.fn().mockResolvedValue('test-key')
    const provider = createZhipuSearchProvider(resolveKey)
    const signal = new AbortController().signal
    const output = await provider.search({ query: '测试', maxResults: 8 }, signal)
    expect(output.sources).toEqual([])
    expect(resolveKey).toHaveBeenCalledOnce()
    expect(mocks.transport).toHaveBeenCalledWith(
      new URL('https://open.bigmodel.cn/api/mcp/web_search_prime/mcp'),
      { requestInit: { headers: { Authorization: 'Bearer test-key' }, redirect: 'error' } },
    )
    expect(mocks.connect.mock.calls[0]?.[1]).toMatchObject({ signal })
    expect(mocks.listTools.mock.calls[0]?.[1]).toMatchObject({ signal })
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: 'web_search_prime', arguments: { search_query: '测试' } },
      { signal, timeout: 30_000, toolDefinition: searchTool },
    )
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('接受服务端文档中的驼峰工具名，拒绝缺失、重复或不兼容的参数 schema', async () => {
    const provider = createZhipuSearchProvider(async () => 'test-key')
    mocks.listTools.mockResolvedValueOnce({ tools: [{ ...searchTool, name: 'webSearchPrime' }] })
    await provider.search({ query: 'ok' })
    expect(mocks.callTool.mock.calls[0]?.[0].name).toBe('webSearchPrime')
    mocks.listTools.mockResolvedValueOnce({ tools: [] })
    await expect(provider.search({ query: 'missing' })).rejects.toThrow('找到 0 个')
    mocks.listTools.mockResolvedValueOnce({ tools: [searchTool, { ...searchTool, name: 'webSearchPrime' }] })
    await expect(provider.search({ query: 'duplicate' })).rejects.toThrow('找到 2 个')
    mocks.listTools.mockResolvedValueOnce({ tools: [{ ...searchTool, inputSchema: { type: 'object' } }] })
    await expect(provider.search({ query: 'schema' })).rejects.toThrow('search_query 参数')
    expect(mocks.close).toHaveBeenCalledTimes(4)
  })

  it('上游失败不回退至其他搜索，已取消时不发起连接', async () => {
    const provider = createZhipuSearchProvider(async () => 'test-key')
    mocks.callTool.mockRejectedValueOnce(new Error('网络断开'))
    await expect(provider.search({ query: '失败' })).rejects.toThrow('网络断开')
    expect(mocks.close).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(provider.search({ query: '取消' }, controller.signal)).rejects.toMatchObject({
      code: 'WEB_ABORTED',
    })
    expect(mocks.connect).toHaveBeenCalledOnce()
  })
})
