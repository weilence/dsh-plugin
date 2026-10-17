/** 智谱网页阅读核心：工具发现、严格解析与取消。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createZhipuReader, parseReaderContent } from '../src/reader'

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

const readerTool = {
  name: 'webReader',
  inputSchema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.connect.mockResolvedValue(undefined)
  mocks.listTools.mockResolvedValue({ tools: [readerTool] })
  mocks.callTool.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ content: '# 正文' }) }],
  })
  mocks.close.mockResolvedValue(undefined)
})

describe('智谱网页阅读解析', () => {
  it('接受摊平 content、reader_result 嵌套与非 JSON 裸 Markdown 三种形状（含双层 JSON 字符串）', () => {
    const flat = JSON.stringify({ content: '# 正文', title: '页' })
    expect(parseReaderContent({ content: [{ type: 'text', text: JSON.stringify(flat) }] })).toBe('# 正文')
    const nested = JSON.stringify({ reader_result: { content: '# 嵌套正文' } })
    expect(parseReaderContent({ content: [{ type: 'text', text: nested }] })).toBe('# 嵌套正文')
    expect(
      parseReaderContent({ structuredContent: { reader_result: { content: '# 结构化正文' } }, content: [] }),
    ).toBe('# 结构化正文')
    expect(parseReaderContent({ content: [{ type: 'text', text: '# 裸 Markdown' }] })).toBe('# 裸 Markdown')
    expect(
      parseReaderContent({ content: [{ type: 'text', text: JSON.stringify('"# 双层编码正文"') }] }),
    ).toBe('# 双层编码正文')
  })

  it('无正文字段的 JSON 形状与空正文明确报错，不伪装成空页', () => {
    expect(() => parseReaderContent({ content: [{ type: 'text', text: '{}' }] })).toThrow('没有正文字段')
    expect(() =>
      parseReaderContent({
        structuredContent: { wrapped: true },
        content: [{ type: 'text', text: JSON.stringify({ wrapped: true }) }],
      }),
    ).toThrow(/没有正文字段（文本 对象\(wrapped\)/)
    expect(() =>
      parseReaderContent({ content: [{ type: 'text', text: JSON.stringify({ content: ' \n\t' }) }] }),
    ).toThrow('空正文')
    // 超大正文只能经 structuredContent 触达：单文本块先被入口长度门拦下。
    expect(() =>
      parseReaderContent({ structuredContent: { content: 'x'.repeat(2_000_001) }, content: [] }),
    ).toThrow('大小限制')
    expect(() =>
      parseReaderContent({ isError: true, content: [{ type: 'text', text: '目标页拒绝访问' }] }),
    ).toThrow('目标页拒绝访问')
  })
})

describe('智谱网页阅读核心', () => {
  it('每次读取凭据、发现工具并传递取消信号，连接关闭后不保留状态', async () => {
    const resolveKey = vi.fn().mockResolvedValue('test-key')
    const read = createZhipuReader(resolveKey)
    const signal = new AbortController().signal
    const output = await read('https://example.com/page', signal)
    expect(output).toBe('# 正文')
    expect(resolveKey).toHaveBeenCalledOnce()
    expect(mocks.transport).toHaveBeenCalledWith(new URL('https://open.bigmodel.cn/api/mcp/web_reader/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer test-key' }, redirect: 'error' },
    })
    expect(mocks.connect.mock.calls[0]?.[1]).toMatchObject({ signal, timeout: 60_000 })
    expect(mocks.callTool).toHaveBeenCalledWith(
      { name: 'webReader', arguments: { url: 'https://example.com/page' } },
      { signal, timeout: 60_000, toolDefinition: readerTool },
    )
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('接受蛇形工具名，拒绝缺失、重复或不兼容的参数 schema', async () => {
    const read = createZhipuReader(async () => 'test-key')
    mocks.listTools.mockResolvedValueOnce({ tools: [{ ...readerTool, name: 'web_reader' }] })
    await read('https://a.example/')
    expect(mocks.callTool.mock.calls[0]?.[0].name).toBe('web_reader')
    mocks.listTools.mockResolvedValueOnce({ tools: [] })
    await expect(read('https://b.example/')).rejects.toThrow('找到 0 个')
    mocks.listTools.mockResolvedValueOnce({ tools: [readerTool, { ...readerTool, name: 'web_reader' }] })
    await expect(read('https://c.example/')).rejects.toThrow('找到 2 个')
    mocks.listTools.mockResolvedValueOnce({ tools: [{ ...readerTool, inputSchema: { type: 'object' } }] })
    await expect(read('https://d.example/')).rejects.toThrow('url 参数')
    expect(mocks.close).toHaveBeenCalledTimes(4)
  })

  it('上游失败不回退，已取消时不发起连接', async () => {
    const read = createZhipuReader(async () => 'test-key')
    mocks.callTool.mockRejectedValueOnce(new Error('网络断开'))
    await expect(read('https://fail.example/')).rejects.toThrow('网络断开')
    expect(mocks.close).toHaveBeenCalledOnce()
    const controller = new AbortController()
    controller.abort()
    await expect(read('https://cancel.example/', controller.signal)).rejects.toMatchObject({
      code: 'WEB_ABORTED',
    })
    expect(mocks.connect).toHaveBeenCalledOnce()
  })
})
