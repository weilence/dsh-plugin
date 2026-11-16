import { describe, expect, it } from 'vitest'
import { createConfluenceClient } from '../../src/confluence'
import type { FetchLike } from '../../src/rest'
import type { ProductSite } from '../../src/shared'

const cloud: ProductSite = {
  name: 'acme',
  kind: 'cloud',
  url: 'https://acme.atlassian.net',
  email: 'a@b.com',
}
const server: ProductSite = { name: 'intra', kind: 'server', url: 'http://conf.intra:8090' }

function capture(bodyByCall: unknown[], status = 200): { fetchImpl: FetchLike; urls: string[] } {
  let index = 0
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    void init
    urls.push(url)
    const body = bodyByCall[Math.min(index, bodyByCall.length - 1)] ?? {}
    index += 1
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchImpl, urls }
}

const searchPayload = {
  results: [
    {
      content: { id: '100', type: 'page', title: '部署手册', space: { key: 'DEV', name: '研发空间' } },
      excerpt: '如何部署……',
      lastModified: '2026-11-01',
      url: '/spaces/DEV/pages/100/部署手册',
    },
    { content: { id: '101', type: 'page', title: '回滚' }, excerpt: '回滚步骤', lastModified: '2026-10-01' },
  ],
  totalSize: 7,
  _links: { next: '/rest/api/search?cql=x&cursor=abc' },
}

describe('createConfluenceClient.search', () => {
  it('cloud 走 /wiki/rest/api/search；相对 url 拼 baseUrl、缺 url 按页面规则构造', async () => {
    const { fetchImpl, urls } = capture([searchPayload])
    const client = createConfluenceClient(cloud, 'tok', fetchImpl)
    const result = await client.search('type=page AND text ~ "部署"', 10)
    expect(urls[0]).toBe(
      'https://acme.atlassian.net/wiki/rest/api/search?cql=type%3Dpage%20AND%20text%20~%20%22%E9%83%A8%E7%BD%B2%22&limit=10',
    )
    expect(result.total).toBe(7)
    expect(result.truncated).toBe(true)
    expect(result.results[0]).toMatchObject({
      id: '100',
      title: '部署手册',
      space: '研发空间',
      excerpt: '如何部署……',
      url: 'https://acme.atlassian.net/spaces/DEV/pages/100/部署手册',
    })
    expect(result.results[1]?.url).toBe('https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=101')
  })

  it('server 走 /rest/api/search', async () => {
    const { fetchImpl, urls } = capture([searchPayload])
    const client = createConfluenceClient(server, 'pat', fetchImpl)
    await client.search('text ~ "x"', 5)
    expect(urls[0]).toContain('http://conf.intra:8090/rest/api/search?cql=')
  })
})

describe('createConfluenceClient.page', () => {
  const pagePayload = {
    id: '100',
    title: '部署手册',
    space: { key: 'DEV', name: '研发空间' },
    version: { number: 3, when: '2026-11-01' },
    body: { storage: { value: '<h1>标题</h1><p>正文 &amp; 说明</p>' } },
  }

  it('取 storage 正文转 markdown，带空间与版本', async () => {
    const { fetchImpl, urls } = capture([pagePayload])
    const client = createConfluenceClient(cloud, 'tok', fetchImpl)
    const page = await client.page('100', { maxChars: 5000, offset: 0 })
    expect(urls[0]).toContain('/wiki/rest/api/content/100?expand=body.storage,space,version')
    expect(page.title).toBe('部署手册')
    expect(page.space).toBe('研发空间')
    expect(page.version).toBe(3)
    expect(page.body).toContain('# 标题')
    expect(page.body).toContain('正文 & 说明')
    expect(page.truncated).toBe(false)
    expect(page.url).toBe('https://acme.atlassian.net/wiki/spaces/DEV/pages/100')
  })

  it('server 页面 URL 用 viewpage.action', async () => {
    const { fetchImpl } = capture([pagePayload])
    const client = createConfluenceClient(server, 'pat', fetchImpl)
    const page = await client.page('100', { maxChars: 5000, offset: 0 })
    expect(page.url).toBe('http://conf.intra:8090/pages/viewpage.action?pageId=100')
  })

  it('server 独立地址即 REST 根（与 Jira 地址无关）', async () => {
    const { fetchImpl, urls } = capture([pagePayload])
    const client = createConfluenceClient(
      { name: 'yamu', kind: 'server', url: 'http://conf.intra:8090/' },
      'pat',
      fetchImpl,
    )
    const page = await client.page('100', { maxChars: 5000, offset: 0 })
    expect(urls[0]).toContain('http://conf.intra:8090/rest/api/content/100?expand=')
    expect(page.url).toBe('http://conf.intra:8090/pages/viewpage.action?pageId=100')
  })

  it('正文截断与 offset 续取', async () => {
    const { fetchImpl } = capture([pagePayload])
    const client = createConfluenceClient(cloud, 'tok', fetchImpl)
    const first = await client.page('100', { maxChars: 3, offset: 0 })
    expect(first.body).toBe(first.body.slice(0, 3))
    expect(first.truncated).toBe(true)
    const rest = await client.page('100', { maxChars: 5000, offset: first.totalChars - 2 })
    expect(rest.truncated).toBe(false)
    expect(rest.body).toContain('说明')
  })
})

describe('createConfluenceClient.spacesProbe', () => {
  it('连接测试打轻量空间列表', async () => {
    const { fetchImpl, urls } = capture([{ results: [] }])
    const client = createConfluenceClient(server, 'pat', fetchImpl)
    await expect(client.spacesProbe()).resolves.toBeUndefined()
    expect(urls[0]).toBe('http://conf.intra:8090/rest/api/space?limit=1')
  })
})
