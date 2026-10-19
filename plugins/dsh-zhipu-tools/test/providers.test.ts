/** provider 适配层：核心同构直通、fetch 映射与 available 快照。 */

import { describe, expect, it, vi } from 'vitest'
import { ZhipuFetchProvider, ZhipuSearchProvider } from '../src/providers'
import type { ZhipuReader } from '../src/reader'
import type { ZhipuSearch } from '../src/search'

describe('ZhipuSearchProvider', () => {
  it('直通 query 与 signal，返回核心结果；maxResults 交 web 服务截断', async () => {
    const signal = new AbortController().signal
    const search = vi.fn(async () => ({ sources: [{ url: 'https://a' }], truncated: false }))
    const provider = new ZhipuSearchProvider(search as unknown as ZhipuSearch, () => true)
    expect(provider.id).toBe('zhipu-search-api')
    expect(provider.available()).toBe(true)
    const result = await provider.search({ query: 'q', maxResults: 3 }, signal)
    expect(search).toHaveBeenCalledWith('q', signal)
    expect(result.sources[0]?.url).toBe('https://a')
  })

  it('available 跟随快照', () => {
    let ready = false
    const provider = new ZhipuSearchProvider(vi.fn() as unknown as ZhipuSearch, () => ready)
    expect(provider.available()).toBe(false)
    ready = true
    expect(provider.available()).toBe(true)
  })
})

describe('ZhipuFetchProvider', () => {
  it('成功映射为 200 + text 正文（webReader 不报目标状态码，口径对齐官方 Fetch API provider）', async () => {
    const read = vi.fn(async () => '# 页面')
    const provider = new ZhipuFetchProvider(read as unknown as ZhipuReader, () => true)
    expect(provider.id).toBe('zhipu-fetch-api')
    const result = await provider.fetch({ url: 'https://a' })
    expect(result).toEqual({
      url: 'https://a',
      statusCode: 200,
      body: { kind: 'text', content: '# 页面' },
      truncated: false,
    })
  })

  it('核心失败原样上抛，不伪装成空页', async () => {
    const read = vi.fn(async () => {
      throw new Error('目标无可用内容')
    })
    const provider = new ZhipuFetchProvider(read as unknown as ZhipuReader, () => true)
    await expect(provider.fetch({ url: 'https://a' })).rejects.toThrow('目标无可用内容')
  })
})
