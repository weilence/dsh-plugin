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

/** 模拟评论端点的真实语义：按 startAt/maxResults/orderBy 切片，检验取数确实从最新往回翻页。 */
function serveComments(
  issuePayload: unknown,
  all: { author: { displayName: string }; created: string; body: unknown }[],
): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = []
  const fetchImpl: FetchLike = async (url) => {
    const target = String(url)
    urls.push(target)
    if (target.includes('/comment?')) {
      const params = new URL(target).searchParams
      const startAt = Number(params.get('startAt') ?? 0)
      const maxResults = Number(params.get('maxResults') ?? 0)
      const ordered = params.get('orderBy') === '-created' ? [...all].reverse() : all
      return new Response(
        JSON.stringify({ comments: ordered.slice(startAt, startAt + maxResults), total: all.length }),
        { status: 200 },
      )
    }
    return new Response(JSON.stringify(issuePayload), { status: 200 })
  }
  return { fetchImpl, urls }
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

  it('cloud：ADF 描述转 markdown，评论从最新往回取并报告截断', async () => {
    const comments = Array.from({ length: 18 }, (_unused, index) => ({
      author: { displayName: `u${index}` },
      created: `2026-01-${String(index + 1).padStart(2, '0')}`,
      body: adfDescription,
    }))
    const { fetchImpl, urls } = serveComments(
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
      comments,
    )
    const client = createJiraClient(cloud, 'tok', fetchImpl)
    const detail = await client.issue('P-9', { comments: 5, maxDescriptionChars: 100 })
    expect(detail.site).toBe('acme')
    expect(urls[1]).toContain('/rest/api/3/issue/P-9/comment?maxResults=15&startAt=0&orderBy=-created')
    expect(detail.description).toBe('描述正文')
    expect(detail.descriptionTruncated).toBe(false)
    expect(detail.labels).toEqual(['a', 'b'])
    expect(detail.reporter).toBe('李四')
    // 最新在前：攒满请求数即停，拿到的恰是最新的 5 条。
    expect(detail.comments.map((comment) => comment.author)).toEqual(['u17', 'u16', 'u15', 'u14', 'u13'])
    expect(detail.comments[0]?.body).toBe('描述正文')
    expect(detail.commentsTruncated).toBe(true)
    expect(detail.commentsFiltered).toBe(0)
  })

  it('排除名单：机器人评论不计入，往回翻页攒满最近的真实评论', async () => {
    const comments = [
      ...Array.from({ length: 5 }, (_unused, index) => ({
        author: { displayName: `u${index}` },
        created: `2026-01-0${index + 1}`,
        body: 'c',
      })),
      ...Array.from({ length: 15 }, (_unused, index) => ({
        author: { displayName: 'gitlab' },
        created: `2026-02-${String(index + 1).padStart(2, '0')}`,
        body: 'bot',
      })),
    ]
    const { fetchImpl, urls } = serveComments({ key: 'K-3', fields: { summary: 'S' } }, comments)
    const client = createJiraClient(server, 'pat', fetchImpl)
    const detail = await client.issue('K-3', {
      comments: 5,
      maxDescriptionChars: 10,
      excludeAuthors: ['GitLab'],
    })
    // 第一页 15 条全是机器人（不计入），第二页攒满 5 条真实评论。
    expect(detail.comments.map((comment) => comment.author)).toEqual(['u4', 'u3', 'u2', 'u1', 'u0'])
    expect(detail.commentsFiltered).toBe(15)
    expect(detail.commentsTruncated).toBe(false)
    expect(urls[2]).toContain('startAt=15')
  })

  it('扫描上限：被排除评论占满近期历史时停在上限并如实报告', async () => {
    const comments = [
      ...Array.from({ length: 5 }, (_unused, index) => ({
        author: { displayName: `u${index}` },
        created: `2026-01-0${index + 1}`,
        body: 'c',
      })),
      ...Array.from({ length: 210 }, (_unused, index) => ({
        author: { displayName: 'gitlab' },
        created: `2026-03-${String(index + 1).padStart(2, '0')}`,
        body: 'bot',
      })),
    ]
    const { fetchImpl } = serveComments({ key: 'K-4', fields: { summary: 'S' } }, comments)
    const client = createJiraClient(server, 'pat', fetchImpl)
    const detail = await client.issue('K-4', {
      comments: 5,
      maxDescriptionChars: 10,
      excludeAuthors: ['gitlab'],
    })
    expect(detail.comments).toEqual([])
    expect(detail.commentsFiltered).toBe(210)
    expect(detail.commentsTruncated).toBe(true)
  })

  it('详情带附件清单（id / filename / size / mimeType），缺字段条目剔除', async () => {
    const { fetchImpl } = serveComments(
      {
        key: 'K-5',
        fields: {
          summary: 'S',
          attachment: [
            {
              id: '100',
              filename: '截图.png',
              size: 2048,
              mimeType: 'image/png',
              content: 'https://j/c/100',
            },
            { id: '101' },
            { filename: 'x.bin', size: 1 },
          ],
        },
      },
      [],
    )
    const client = createJiraClient(server, 'pat', fetchImpl)
    const detail = await client.issue('K-5', { comments: 0, maxDescriptionChars: 10 })
    expect(detail.attachments).toEqual([
      { id: '100', filename: '截图.png', size: 2048, mimeType: 'image/png' },
    ])
  })

  it('attachment(id) 取元数据（content 绝对 URL），download 按 URL 拉字节', async () => {
    const { fetchImpl, urls, inits } = capture([
      {
        id: '100',
        filename: 'a.png',
        size: 3,
        mimeType: 'image/png',
        content: 'https://jira.example.com/secure/attachment/100/a.png',
      },
    ])
    const client = createJiraClient(server, 'pat', fetchImpl)
    const meta = await client.attachment('100')
    expect(meta).toEqual({
      filename: 'a.png',
      size: 3,
      mimeType: 'image/png',
      content: 'https://jira.example.com/secure/attachment/100/a.png',
    })
    expect(urls[0]).toContain('/rest/api/2/attachment/100')
    expect(inits[0]?.headers).toMatchObject({ authorization: 'Bearer pat' })

    const binFetch: FetchLike = async () => new Response(new Uint8Array([104, 105]), { status: 200 })
    const downloader = createJiraClient(server, 'tok', binFetch)
    const data = await downloader.download(meta.content)
    expect(data.toString()).toBe('hi')
  })

  it('attachment 元数据缺 filename / content 显式报错', async () => {
    const { fetchImpl } = capture([{ id: '9', filename: 'x' }])
    const client = createJiraClient(server, 'pat', fetchImpl)
    await expect(client.attachment('9')).rejects.toThrow(/元数据不完整/)
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
