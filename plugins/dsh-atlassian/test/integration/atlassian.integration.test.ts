/** 真 socket 集成：本地 HTTP 服务器模拟 Atlassian 端点，cloud 形态全链路。 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createJiraClient } from '../../src/jira'
import { createConfluenceClient } from '../../src/confluence'
import { createRestClient } from '../../src/rest'

let server: Server
let denyServer: Server
let baseUrl = ''
let denyUrl = ''
const seen: { url: string; authorization?: string; method?: string; body?: string }[] = []

const site = { name: 'acme', kind: 'cloud' as const, baseUrl: '', email: 'a@b.io' }

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const url = req.url ?? ''
      seen.push({
        url,
        authorization: req.headers.authorization,
        method: req.method,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const json = (payload: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (url.startsWith('/rest/api/3/search/jql')) {
        json({
          issues: [{ key: 'I-1', fields: { summary: '集成工单', status: { name: 'Todo' } } }],
          total: 1,
        })
      } else if (url.includes('/rest/api/3/issue/I-1/comment')) {
        json({
          comments: [
            {
              author: { displayName: 'u' },
              created: 't',
              body: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: '评论正文' }] }],
              },
            },
          ],
          total: 1,
        })
      } else if (url.includes('/secure/attachment/100/a.png')) {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(Buffer.from([1, 2, 3]))
      } else if (url.includes('/rest/api/3/attachment/100')) {
        json({
          id: '100',
          filename: 'a.png',
          size: 3,
          mimeType: 'image/png',
          content: `${baseUrl}/secure/attachment/100/a.png`,
        })
      } else if (url.includes('/rest/api/3/issue/I-1')) {
        json({
          key: 'I-1',
          fields: {
            summary: '集成工单',
            status: { name: 'Todo' },
            description: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: '描述正文' }] }],
            },
            attachment: [
              {
                id: '100',
                filename: 'a.png',
                size: 3,
                mimeType: 'image/png',
                content: `${baseUrl}/secure/attachment/100/a.png`,
              },
            ],
          },
        })
      } else if (url.includes('/myself')) {
        json({ accountId: 'x' })
      } else if (url.includes('/wiki/rest/api/search')) {
        json({
          results: [
            {
              content: { id: '9', type: 'page', title: '集成页', space: { key: 'DEV', name: '研发' } },
              excerpt: '摘',
              lastModified: '今天',
              url: '/spaces/DEV/pages/9/T',
            },
          ],
          totalSize: 1,
        })
      } else if (url.includes('/wiki/rest/api/content/9')) {
        json({
          id: '9',
          title: '集成页',
          space: { key: 'DEV', name: '研发' },
          version: { number: 2, when: '2026-11-01' },
          body: { storage: { value: '<h1>集成</h1><p>正文 &amp; 更多</p>' } },
        })
      } else if (url.includes('/rest/api/space')) {
        json({ results: [] })
      } else {
        res.writeHead(404)
        res.end('{}')
      }
    })
  })
  denyServer = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ errorMessages: ['denied'] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  await new Promise<void>((resolve) => denyServer.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  denyUrl = `http://127.0.0.1:${(denyServer.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  await new Promise<void>((resolve, reject) =>
    denyServer.close((error) => (error === undefined ? resolve() : reject(error))),
  )
})

describe('真 socket：cloud 形态全链路', () => {
  it('Basic 认证头与服务端接收一致', async () => {
    const rest = createRestClient({ ...site, url: baseUrl }, 'tok')
    await rest.get('/rest/api/3/myself')
    expect(seen[0]?.authorization).toBe(`Basic ${Buffer.from('a@b.io:tok').toString('base64')}`)
  })

  it('搜索 → 详情 → 评论的完整工具链路', async () => {
    const jira = createJiraClient({ ...site, url: baseUrl }, 'tok')
    const search = await jira.search('project = INT', 10)
    expect(search.issues[0]?.key).toBe('I-1')
    expect(search.issues[0]?.url).toBe(`${baseUrl}/browse/I-1`)

    const detail = await jira.issue('I-1', { comments: 5, maxDescriptionChars: 1000 })
    expect(detail.site).toBe('acme')
    expect(detail.description).toBe('描述正文')
    expect(detail.comments).toHaveLength(1)
    expect(detail.comments[0]?.body).toBe('评论正文')
    expect(detail.attachments).toEqual([{ id: '100', filename: 'a.png', size: 3, mimeType: 'image/png' }])

    const meta = await jira.attachment('100')
    expect(meta.filename).toBe('a.png')
    expect(meta.content).toBe(`${baseUrl}/secure/attachment/100/a.png`)
    const data = await jira.download(meta.content)
    expect([...data]).toEqual([1, 2, 3])
    const downloadAuth = seen.find((entry) => entry.url.includes('/secure/attachment/'))?.authorization
    expect(downloadAuth).toBe(`Basic ${Buffer.from('a@b.io:tok').toString('base64')}`)

    const confluence = createConfluenceClient({ ...site, url: baseUrl }, 'tok')
    const found = await confluence.search('text ~ "集成"', 5)
    expect(found.results[0]?.title).toBe('集成页')
    expect(found.results[0]?.url).toBe(`${baseUrl}/spaces/DEV/pages/9/T`)
    const page = await confluence.page('9', { maxChars: 2000, offset: 0 })
    expect(page.body).toContain('# 集成')
    expect(page.body).toContain('正文 & 更多')
    expect(page.url).toBe(`${baseUrl}/wiki/spaces/DEV/pages/9`)
  })

  it('401 从真 socket 映射为凭据语义', async () => {
    const rest = createRestClient({ name: 'deny', kind: 'server', url: denyUrl }, 'bad')
    await expect(rest.get('/rest/api/2/myself')).rejects.toThrow(/凭据无效或权限不足.*denied/s)
  })
})
