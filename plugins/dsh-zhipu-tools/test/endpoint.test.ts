/** 端点：DeepSeek Web Tools 协议路由（假 req/res）与监听生命周期（真回环）。 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebError, type WebSearchResult } from '@deepseek-ai/dsh-web'
import { createEndpointRouter, startEndpointServer } from '../src/endpoint'

const TOKEN = 'ab'.repeat(16)
const BEARER = { authorization: `Bearer ${TOKEN}` }
const NOOP_SEARCH = vi.fn(async (): Promise<WebSearchResult> => ({ sources: [], truncated: false }))
const NOOP_READ = vi.fn(async (): Promise<string> => '# 页面 Markdown')

interface CapturedResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

/** 与真实 ServerResponse 的最小面齐平：writeHead/write/end/destroy + close 订阅。 */
function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, headers: {}, body: Buffer.alloc(0) }
  const chunks: Buffer[] = []
  let settled = false
  let resolveDone: (capture: CapturedResponse) => void
  const done = new Promise<CapturedResponse>((resolve) => {
    resolveDone = resolve
  })
  const settle = (): void => {
    if (settled) return
    settled = true
    captured.body = Buffer.concat(chunks)
    resolveDone!(captured)
  }
  const res = {
    writableEnded: false,
    headersSent: false,
    writableFinished: false,
    writeHead(status: number, headers: Record<string, string>) {
      captured.status = status
      captured.headers = headers
      res.headersSent = true
    },
    write(chunk: Buffer) {
      chunks.push(Buffer.from(chunk))
    },
    end(payload?: Buffer) {
      if (payload !== undefined) chunks.push(Buffer.from(payload))
      res.writableEnded = true
      res.writableFinished = true
      settle()
    },
    destroy() {
      res.writableEnded = true
      settle()
    },
    on() {},
  }
  return { res: res as unknown as ServerResponse, done }
}

function fakeReq(
  url: string,
  body: unknown,
  options: { method?: string; headers?: Record<string, string | string[] | undefined> } = {},
): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  const stream = (async function* () {
    yield payload
  })()
  return {
    url,
    method: options.method ?? 'POST',
    headers: { host: '127.0.0.1:39617', ...options.headers },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  } as unknown as IncomingMessage
}

async function json(capture: CapturedResponse): Promise<Record<string, unknown>> {
  return JSON.parse(capture.body.toString('utf8')) as Record<string, unknown>
}

describe('端点路由：信任边界与形状', () => {
  const search = vi.fn()
  const router = createEndpointRouter({ token: TOKEN, search, read: NOOP_READ })

  beforeEach(() => {
    vi.clearAllMocks()
    search.mockImplementation(NOOP_SEARCH)
  })

  it('search 映射成官方协议形状：date 在场、count 截断、publishedAt 透传', async () => {
    search.mockResolvedValue({
      sources: [
        { url: 'https://a.example/', title: '甲', snippet: '摘要甲', publishedAt: '2026-01-02' },
        { url: 'https://b.example/' },
      ],
      truncated: false,
    })
    const { res, done } = fakeRes()
    await router(
      fakeReq('/search', { query: '关键词', count: 1, need_content: false }, { headers: BEARER }),
      res,
    )
    const capture = await done
    expect(capture.status).toBe(200)
    // 官方解析器要求 date 键在场（null 或字符串），undefined 会被判无效响应。
    await expect(json(capture)).resolves.toEqual({
      results: [{ url: 'https://a.example/', title: '甲', snippet: '摘要甲', date: '2026-01-02' }],
    })
  })

  it('无 count 时上限 50，来源缺 title/snippet 时落空串、缺 publishedAt 时落 null', async () => {
    search.mockResolvedValue({ sources: [{ url: 'https://b.example/' }], truncated: false })
    const { res, done } = fakeRes()
    await router(fakeReq('/search', { query: 'q' }, { headers: BEARER }), res)
    await expect(json(await done)).resolves.toEqual({
      results: [{ url: 'https://b.example/', title: '', snippet: '', date: null }],
    })
  })

  it('智谱侧 WebError 映射为 502 + 原文 error，解析失败不当零结果', async () => {
    search.mockRejectedValue(
      new WebError('未配置智谱 Coding Plan API Key（ZAI_CODING_CN_API_KEY）', 'WEB_PROVIDER_ERROR'),
    )
    const { res, done } = fakeRes()
    await router(fakeReq('/search', { query: 'q' }, { headers: BEARER }), res)
    const capture = await done
    expect(capture.status).toBe(502)
    await expect(json(capture)).resolves.toMatchObject({
      error: expect.stringContaining('ZAI_CODING_CN_API_KEY'),
    })
  })

  it('请求体校验：query 缺失/空白与 count 非法都拒 400', async () => {
    for (const body of [
      {},
      { query: '' },
      { query: ' q ' },
      { query: 'q', count: 0 },
      { query: 'q', count: 1.5 },
      { query: 'q', count: '5' },
    ]) {
      const { res, done } = fakeRes()
      await router(fakeReq('/search', body, { headers: BEARER }), res)
      expect((await done).status).toBe(400)
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('信任边界：非 loopback Host 与跨站标记拒 403，非 POST 拒 405', async () => {
    const cases: { req: IncomingMessage; status: number }[] = [
      {
        req: fakeReq('/search', { query: 'q' }, { headers: { ...BEARER, host: 'evil.example' } }),
        status: 403,
      },
      {
        req: fakeReq('/search', { query: 'q' }, { headers: { ...BEARER, 'sec-fetch-site': 'cross-site' } }),
        status: 403,
      },
      { req: fakeReq('/search', { query: 'q' }, { headers: BEARER, method: 'GET' }), status: 405 },
    ]
    for (const { req, status } of cases) {
      const { res, done } = fakeRes()
      await router(req, res)
      expect((await done).status).toBe(status)
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('鉴权：缺失与错误 Bearer 同形 401，正确令牌放行', async () => {
    const missing = fakeRes()
    await router(fakeReq('/search', { query: 'q' }), missing.res)
    expect((await missing.done).status).toBe(401)

    const wrong = fakeRes()
    await router(
      fakeReq('/search', { query: 'q' }, { headers: { authorization: `Bearer ${'cd'.repeat(16)}` } }),
      wrong.res,
    )
    expect((await wrong.done).status).toBe(401)

    const malformed = fakeRes()
    await router(fakeReq('/search', { query: 'q' }, { headers: { authorization: TOKEN } }), malformed.res)
    expect((await malformed.done).status).toBe(401)

    const ok = fakeRes()
    await router(
      fakeReq('/search', { query: 'q' }, { headers: { authorization: `bearer ${TOKEN}` } }),
      ok.res,
    )
    expect((await ok.done).status).toBe(200)
    expect(search).toHaveBeenCalledOnce()
  })

  it('路径不对（含旧版 /t/<token> 形态）一律 404', async () => {
    for (const url of [`/t/${TOKEN}/search`, `/t/${'cd'.repeat(16)}/search`, '/nope', '/search/extra', '/']) {
      const { res, done } = fakeRes()
      await router(fakeReq(url, { query: 'q' }, { headers: BEARER }), res)
      expect((await done).status).toBe(404)
    }
    expect(search).not.toHaveBeenCalled()
  })

  it('query 串被剥掉，路径仍按 pathname 判定', async () => {
    const { res, done } = fakeRes()
    await router(fakeReq('/search?x=1', { query: 'q' }, { headers: BEARER }), res)
    expect((await done).status).toBe(200)
  })
})

describe('端点路由：/fetch 智谱网页阅读', () => {
  const read = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    read.mockImplementation(NOOP_READ)
  })

  it('按官方契约把 reader 正文映射为 {content}', async () => {
    const router = createEndpointRouter({ token: TOKEN, search: NOOP_SEARCH, read })
    const { res, done } = fakeRes()
    await router(fakeReq('/fetch', { url: 'https://page.example/' }, { headers: BEARER }), res)
    const capture = await done
    expect(capture.status).toBe(200)
    expect(read).toHaveBeenCalledWith('https://page.example/', expect.any(AbortSignal))
    await expect(json(capture)).resolves.toEqual({ content: '# 页面 Markdown' })
  })

  it('reader 失败原样落 502，不回退、不伪装成空页', async () => {
    read.mockRejectedValue(
      new WebError('智谱网页阅读返回了空正文（目标页可能没有可提取内容）', 'WEB_PROVIDER_ERROR'),
    )
    const router = createEndpointRouter({ token: TOKEN, search: NOOP_SEARCH, read })
    const { res, done } = fakeRes()
    await router(fakeReq('/fetch', { url: 'https://empty.example/' }, { headers: BEARER }), res)
    const capture = await done
    expect(capture.status).toBe(502)
    await expect(json(capture)).resolves.toMatchObject({
      error: expect.stringContaining('空正文'),
    })
  })

  it('缺鉴权与非法请求体分别拒 401 / 400', async () => {
    const router = createEndpointRouter({ token: TOKEN, search: NOOP_SEARCH, read })
    const unauthenticated = fakeRes()
    await router(fakeReq('/fetch', { url: 'https://a.example/' }), unauthenticated.res)
    expect((await unauthenticated.done).status).toBe(401)

    const invalid = fakeRes()
    await router(fakeReq('/fetch', {}, { headers: BEARER }), invalid.res)
    expect((await invalid.done).status).toBe(400)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('端点监听生命周期', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-zhipu-endpoint-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('状态文件持久化端口与 token，重启地址不变；真实 HTTP 往返符合协议', async () => {
    const stateFile = join(root, 'dsh-zhipu-tools.json')
    const first = await startEndpointServer({ stateFile, search: NOOP_SEARCH, read: NOOP_READ })
    try {
      // 地址不再携带秘密：token 走 Bearer 头（即面板展示的 API 密钥）。
      expect(first.baseUrl).toBe(`http://127.0.0.1:${String(first.port)}`)
      // 不硬断言默认端口：本机真实端点可能正占用 39617，自愈行为由专门用例覆盖。
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ port: first.port, token: first.token })

      // 真实回环往返：内置提供方就是带这些头与形状发请求的。
      const response = await fetch(`${first.baseUrl}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${first.token}`,
          'user-agent': 'deepseek-harness/0.0.1',
        },
        body: JSON.stringify({ query: 'q', count: 5, need_content: false }),
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ results: [] })
      expect((await fetch(`${first.baseUrl}/search`, { method: 'GET' })).status).toBe(405)
      expect((await fetch(`${first.baseUrl}/search`, { method: 'POST' })).status).toBe(401)
      expect(
        (
          await fetch(`${first.baseUrl}/search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${'cd'.repeat(16)}` },
            body: JSON.stringify({ query: 'q' }),
          })
        ).status,
      ).toBe(401)
    } finally {
      await first.close()
    }

    const second = await startEndpointServer({ stateFile, search: NOOP_SEARCH, read: NOOP_READ })
    try {
      expect(second.baseUrl).toBe(first.baseUrl)
    } finally {
      await second.close()
    }
  })

  it('端口被占时回退系统分配并回写状态文件，原服务不受影响', async () => {
    const stateFile = join(root, 'dsh-zhipu-tools.json')
    const holder = await startEndpointServer({ stateFile, search: NOOP_SEARCH, read: NOOP_READ })
    const mover: Array<() => Promise<void>> = [() => holder.close()]
    try {
      const moved = await startEndpointServer({ stateFile, search: NOOP_SEARCH, read: NOOP_READ })
      mover.push(() => moved.close())
      expect(moved.port).not.toBe(holder.port)
      expect(JSON.parse(await readFile(stateFile, 'utf8'))).toEqual({ port: moved.port, token: moved.token })
      // 两个实例各自可服务。
      for (const instance of [holder, moved]) {
        expect(
          (
            await fetch(`${instance.baseUrl}/search`, {
              method: 'POST',
              body: JSON.stringify({ query: 'q' }),
              headers: { 'content-type': 'application/json', authorization: `Bearer ${instance.token}` },
            })
          ).status,
        ).toBe(200)
      }
    } finally {
      await Promise.all(mover.map((close) => close()))
    }
  })

  it('状态文件损坏或形状不对时明确报错，不静默重置 token', async () => {
    for (const [content, pattern] of [
      ['not-json', /不是有效 JSON/],
      [JSON.stringify({ port: 'x', token: 'ab'.repeat(16) }), /不符合预期/],
      [JSON.stringify({ port: 70000, token: 'ab'.repeat(16) }), /不符合预期/],
      [JSON.stringify({ port: 39617, token: 'zz'.repeat(16) }), /不符合预期/],
    ] as const) {
      const stateFile = join(root, 'dsh-zhipu-tools.json')
      await writeFile(stateFile, content, 'utf8')
      await expect(startEndpointServer({ stateFile, search: NOOP_SEARCH, read: NOOP_READ })).rejects.toThrow(
        pattern,
      )
    }
  })
})
