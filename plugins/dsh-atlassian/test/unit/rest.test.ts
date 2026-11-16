import { describe, expect, it } from 'vitest'
import { authHeaders, createRestClient, type FetchLike } from '../../src/rest'
import type { ProductSite } from '../../src/shared'

const cloud: ProductSite = {
  name: 'acme',
  kind: 'cloud',
  url: 'https://acme.atlassian.net',
  email: 'a@b.com',
}
const server: ProductSite = { name: 'intra', kind: 'server', url: 'http://jira.intra:8080' }

describe('authHeaders', () => {
  it('cloud 为 Basic（email:token 的 base64）', () => {
    const expected = Buffer.from('a@b.com:tok').toString('base64')
    expect(authHeaders(cloud, 'tok')).toEqual({ authorization: `Basic ${expected}` })
  })

  it('server 为 Bearer PAT', () => {
    expect(authHeaders(server, 'pat-1')).toEqual({ authorization: 'Bearer pat-1' })
  })
})

describe('createRestClient', () => {
  const okFetch: FetchLike = async () => new Response(JSON.stringify({ ok: 1 }), { status: 200 })

  it('GET 拼 url + accept + 认证头', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const capture: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okFetch(url, init)
    }
    const rest = createRestClient(cloud, 'tok', capture)
    await rest.get('/rest/api/3/myself')
    expect(calls[0]?.url).toBe('https://acme.atlassian.net/rest/api/3/myself')
    expect((calls[0]?.init.headers as Record<string, string>).accept).toBe('application/json')
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toContain('Basic ')
  })

  it('POST 带 JSON 体与 content-type', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const capture: FetchLike = async (url, init) => {
      calls.push({ url, init })
      return okFetch(url, init)
    }
    const rest = createRestClient(cloud, 'tok', capture)
    await rest.post('/rest/api/3/search/jql', { jql: 'x' })
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ jql: 'x' })
  })

  it('url 尾部斜杠收敛', async () => {
    const calls: string[] = []
    const capture: FetchLike = async (url, init) => {
      calls.push(url)
      return okFetch(url, init)
    }
    const rest = createRestClient({ ...server, url: 'http://jira.intra:8080/' }, 't', capture)
    await rest.get('/rest/api/2/myself')
    expect(calls[0]).toBe('http://jira.intra:8080/rest/api/2/myself')
  })

  it('401 → 凭据语义的 HttpError，errorMessages 拼入原因', async () => {
    const deny: FetchLike = async () =>
      new Response(JSON.stringify({ errorMessages: ['没有权限'] }), { status: 403 })
    const rest = createRestClient(server, 'bad', deny)
    await expect(rest.get('/rest/api/2/myself')).rejects.toThrow(/凭据无效或权限不足.*没有权限/s)
  })

  it('404 / 429 各有明确语义', async () => {
    const rest = createRestClient(server, 't', async () => new Response('{}', { status: 404 }))
    await expect(rest.get('/x')).rejects.toThrow(/未找到/)
    const rest2 = createRestClient(server, 't', async () => new Response('{}', { status: 429 }))
    await expect(rest2.get('/x')).rejects.toThrow(/速率受限/)
  })

  it('调用方取消原样抛出（不包装成 HttpError）', async () => {
    const controller = new AbortController()
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    const rest = createRestClient(server, 't', slow)
    const pending = rest.get('/x', controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
