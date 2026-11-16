import { describe, expect, it } from 'vitest'
import { createJiraClient } from '../../src/jira'
import type { FetchLike } from '../../src/rest'
import type { ProductSite } from '../../src/shared'

const cloud: ProductSite = {
  name: 'acme',
  kind: 'cloud',
  url: 'https://acme.atlassian.net',
  email: 'a@b.com',
}
const server: ProductSite = { name: 'intra', kind: 'server', url: 'http://jira.intra:8080' }

function capture(
  bodyByCall: unknown[],
  status = 200,
): { fetchImpl: FetchLike; urls: string[]; inits: RequestInit[] } {
  let index = 0
  const urls: string[] = []
  const inits: RequestInit[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    urls.push(url)
    inits.push(init)
    const body = bodyByCall[Math.min(index, bodyByCall.length - 1)] ?? {}
    index += 1
    return new Response(JSON.stringify(body), { status })
  }
  return { fetchImpl, urls, inits }
}

const searchPayload = {
  issues: [
    {
      key: 'P-1',
      fields: {
        summary: '第一',
        issuetype: { name: 'Bug' },
        status: { name: 'In Progress' },
        assignee: { displayName: '张三' },
        updated: '2026-11-01T00:00:00.000+0000',
      },
    },
    { key: 'P-2', fields: { summary: '第二' } },
  ],
  total: 5,
}

describe('createJiraClient.search', () => {
  it('cloud 走新 /search/jql（POST），分页语义取 total', async () => {
    const { fetchImpl, urls, inits } = capture([searchPayload])
    const client = createJiraClient(cloud, 'tok', fetchImpl)
    const result = await client.search('assignee = currentUser()', 2)
    expect(urls[0]).toBe('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(inits[0]?.method).toBe('POST')
    expect(JSON.parse(String(inits[0]?.body))).toEqual({
      jql: 'assignee = currentUser()',
      maxResults: 2,
      fields: ['summary', 'issuetype', 'status', 'assignee', 'reporter', 'labels', 'created', 'updated'],
    })
    expect(result.total).toBe(5)
    expect(result.truncated).toBe(true)
    expect(result.issues[0]).toMatchObject({
      key: 'P-1',
      summary: '第一',
      status: 'In Progress',
      assignee: '张三',
    })
    expect(result.issues[0]?.url).toBe('https://acme.atlassian.net/browse/P-1')
    expect(result.issues[1]?.status).toBeUndefined()
  })

  it('server 走 /rest/api/2/search（GET）', async () => {
    const { fetchImpl, urls, inits } = capture([{ issues: [], total: 0 }])
    const client = createJiraClient(server, 'pat', fetchImpl)
    await client.search('x', 10)
    expect(urls[0]).toContain('http://jira.intra:8080/rest/api/2/search?jql=x&maxResults=10&fields=')
    expect(inits[0]?.method).toBe('GET')
  })

  it('无 total 时以 nextPageToken 判定截断', async () => {
    const { fetchImpl } = capture([{ issues: [], nextPageToken: 'abc' }])
    const client = createJiraClient(cloud, 'tok', fetchImpl)
    const result = await client.search('x', 1)
    expect(result.total).toBeNull()
    expect(result.truncated).toBe(true)
  })
})

describe('createJiraClient.issue', () => {
  const adfDescription = {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '描述正文' }] }],
  }

  it('cloud：ADF 描述转 markdown，评论取尾窗并报告截断', async () => {
    const comments = Array.from({ length: 18 }, (_unused, index) => ({
      author: { displayName: `u${index}` },
      created: `2026-01-${String(index + 1).padStart(2, '0')}`,
      body: adfDescription,
    }))
    const { fetchImpl, urls } = capture([
      {
        key: 'P-9',
        fields: {
          summary: '标题',
          status: { name: 'Open' },
          labels: ['a', 'b'],
          description: adfDescription,
          reporter: { displayName: '李四' },
        },
      },
      { comments, total: 30 },
    ])
    const client = createJiraClient(cloud, 'tok', fetchImpl)
    const detail = await client.issue('P-9', { comments: 5, maxDescriptionChars: 100 })
    expect(urls[1]).toContain('/rest/api/3/issue/P-9/comment?maxResults=15')
    expect(detail.description).toBe('描述正文')
    expect(detail.descriptionTruncated).toBe(false)
    expect(detail.labels).toEqual(['a', 'b'])
    expect(detail.reporter).toBe('李四')
    expect(detail.comments).toHaveLength(5)
    expect(detail.comments[0]?.author).toBe('u13')
    expect(detail.comments[4]?.author).toBe('u17')
    expect(detail.comments[0]?.body).toBe('描述正文')
    expect(detail.commentsTruncated).toBe(true)
  })

  it('server：wiki 描述轻转换；comments=0 不请求评论端点', async () => {
    const { fetchImpl, urls } = capture([{ key: 'K-1', fields: { summary: 'S', description: 'h3. 小标题' } }])
    const client = createJiraClient(server, 'pat', fetchImpl)
    const detail = await client.issue('K-1', { comments: 0, maxDescriptionChars: 100 })
    expect(urls).toHaveLength(1)
    expect(detail.description).toContain('### 小标题')
    expect(detail.comments).toEqual([])
    expect(detail.commentsTruncated).toBe(false)
  })

  it('描述超长按 maxDescriptionChars 截断', async () => {
    const longText = 'x'.repeat(300)
    const { fetchImpl } = capture([{ key: 'K-2', fields: { summary: 'S', description: longText } }])
    const client = createJiraClient(server, 'pat', fetchImpl)
    const detail = await client.issue('K-2', { comments: 0, maxDescriptionChars: 50 })
    expect(detail.description).toHaveLength(50)
    expect(detail.descriptionTruncated).toBe(true)
    expect(detail.descriptionTotalChars).toBe(300)
  })
})

describe('createJiraClient.myself', () => {
  it('连接测试打轻量端点', async () => {
    const { fetchImpl, urls } = capture([{ accountId: 'a' }])
    const client = createJiraClient(server, 'pat', fetchImpl)
    await expect(client.myself()).resolves.toBeUndefined()
    expect(urls[0]).toBe('http://jira.intra:8080/rest/api/2/myself')
  })
})
