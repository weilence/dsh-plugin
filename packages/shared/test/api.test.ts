import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBridgeClient, withQuery } from '../src/api'

interface FetchCall {
  path: string
  init: RequestInit | undefined
}

function stubFetch(responses: { ok?: boolean; status?: number; body?: string }[]) {
  const calls: FetchCall[] = []
  const mock = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init })
    const preset = responses[Math.min(calls.length - 1, responses.length - 1)]
    const status = preset.status ?? 200
    return { ok: preset.ok ?? status < 400, status, text: async () => preset.body ?? '' }
  })
  vi.stubGlobal('fetch', mock)
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createBridgeClient', () => {
  it('GET 带 Accept 头并解析 JSON', async () => {
    const calls = stubFetch([{ body: '{"x":1}' }])
    const client = createBridgeClient('x-dsh-test')
    await expect(client.request('/bridge/list')).resolves.toEqual({ x: 1 })
    expect(calls[0]).toMatchObject({ path: '/bridge/list' })
    expect(calls[0]?.init).toMatchObject({ method: 'GET', headers: { Accept: 'application/json' } })
  })

  it('POST 带自定义头与 content-type，跨站简单请求折进 CORS 预检', async () => {
    const calls = stubFetch([{ body: '{}' }])
    const client = createBridgeClient('x-dsh-test')
    await client.request('/bridge/save', { method: 'POST', body: '{"a":1}' })
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      body: '{"a":1}',
      headers: { 'content-type': 'application/json', 'x-dsh-test': '1' },
    })
  })

  it('非 2xx 时抛带 status 的 Error，优先取业务 error 字段', async () => {
    stubFetch([{ status: 409, body: '{"error":"已被占用"}' }])
    const client = createBridgeClient('x-dsh-test')
    const error = (await client.request('/bridge/save').catch((e: unknown) => e)) as {
      status?: unknown
      message?: unknown
    }
    expect(error).toBeInstanceOf(Error)
    expect(error.status).toBe(409)
    expect(error.message).toBe('已被占用')
  })

  it('非 2xx 且无业务 error 字段时回退 HTTP <status>', async () => {
    stubFetch([{ status: 503, body: '{"other":1}' }])
    const client = createBridgeClient('x-dsh-test')
    const error = (await client.request('/bridge/list').catch((e: unknown) => e)) as {
      status?: unknown
      message?: unknown
    }
    expect(error.message).toBe('HTTP 503')
  })

  it('响应体不是 JSON 时抛 HTTP <status>（即便 2xx）', async () => {
    stubFetch([{ status: 200, body: '<html>' }])
    const client = createBridgeClient('x-dsh-test')
    const error = (await client.request('/bridge/list').catch((e: unknown) => e)) as {
      status?: unknown
      message?: unknown
    }
    expect(error.message).toBe('HTTP 200')
  })
})

describe('withQuery', () => {
  it('跳过 undefined 与空串参数', () => {
    expect(withQuery('/bridge/list', { cwd: 'd:/x', scope: undefined, extra: '' })).toBe(
      '/bridge/list?cwd=d%3A%2Fx',
    )
  })

  it('全部为空时保持原路径', () => {
    expect(withQuery('/bridge/list', { scope: undefined })).toBe('/bridge/list')
  })
})
