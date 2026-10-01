import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { RemoteTransportPath } from '@dsh-plugins/shared/remote'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteEngine } from '../src/engine'
import type { EngineDeps } from '../src/engine'
import type { ConnRow, ConnRunning, ConnState } from '../src/shared'
import { RemoteTransportService } from '../src/transport'

const servers: ReturnType<typeof createServer>[] = []
const contexts: Context[] = []

async function remote(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('测试服务没有监听 TCP 端口')
  const port = address.port
  const authority = `127.0.0.1:${port}`
  return { port, authority, url: `http://${authority}/?token=launch-secret` }
}

function cookie(authority: string, value = 'session') {
  return `dsh-auth-${createHash('sha256').update(authority).digest('base64url')}=${value}`
}

function authenticate(req: IncomingMessage, res: ServerResponse) {
  expect(req.method).toBe('GET')
  expect(req.url).toBe('/?token=launch-secret')
  expect(req.headers.authorization).toBeUndefined()
  expect(req.headers.cookie).toBeUndefined()
  res.writeHead(303, {
    location: './',
    'set-cookie': `${cookie(req.headers.host!)}; Path=/; HttpOnly; SameSite=Strict`,
  })
  res.end()
}

function row(running: ConnRunning | null, state: Partial<ConnState> = {}, id = 'dev'): ConnRow {
  return {
    id,
    label: `开发机 ${id}`,
    sshAlias: id,
    createdAt: '2027-01-01',
    updatedAt: '2027-01-01',
    state: {
      phase: running === null ? 'idle' : 'running',
      op: null,
      running,
      error: null,
      lastSync: { skills: null, mcp: null, plugins: null, prompts: null },
      ...state,
    },
  }
}

function running(target: { port: number; url: string }): ConnRunning {
  return { url: target.url, localPort: target.port, remotePort: 19387, pid: 42, since: '2027-01-01' }
}

function transport(rows: ConnRow[]) {
  const ctx = new Context()
  contexts.push(ctx)
  // 保持真实引擎实例，替换只读快照；传输不允许自行调用 load 或启动另一个引擎。
  const engine = new RemoteEngine({} as EngineDeps)
  vi.spyOn(engine, 'rows').mockImplementation(() => rows)
  const load = vi.spyOn(engine, 'load')
  new RemoteTransportService(ctx, engine)
  return { service: ctx.remoteTransport, load }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

describe('RemoteTransportService', () => {
  it('以正式 Cordis 服务复用快照，GET 启动 token 后仅同 authority 的 Cookie POST JSON', async () => {
    const calls: string[] = []
    const target = await remote((req, res) => {
      calls.push(`${req.method} ${req.url}`)
      if (req.method === 'GET') return authenticate(req, res)
      expect(req.url).toBe('/dsh-sessions/preview')
      expect(req.headers.cookie).toBe(cookie(target.authority))
      expect(req.headers.authorization).toBeUndefined()
      expect(req.headers['content-type']).toBe('application/json')
      expect(req.headers['x-dsh-sessions']).toBe('1')
      expect(req.headers['sec-fetch-site']).toBe('same-origin')
      expect(req.headers.origin).toBe(`http://${target.authority}`)
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ archive: 'YWJj', cwd: '/project' })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ preview: true }))
      })
    })
    const { service, load } = transport([row(running(target))])
    expect(service.listConnections()).toEqual([{ id: 'dev', label: '开发机 dev', available: true }])
    await expect(
      service.request('dev', '/dsh-sessions/preview', { archive: 'YWJj', cwd: '/project' }),
    ).resolves.toEqual({ preview: true })
    expect(calls).toEqual(['GET /?token=launch-secret', 'POST /dsh-sessions/preview'])
    expect(load).not.toHaveBeenCalled()
  })

  it('入口保留所有连接，并区分测试中的 probing、操作忙、连接中与断开', async () => {
    const target = { port: 12345, url: 'http://127.0.0.1:12345/?token=launch-secret' }
    const rows = [
      row(null, {}, 'idle'),
      row(running(target), { phase: 'probing', op: { kind: 'test' } }, 'test'),
      row(running(target), { op: { kind: 'sync-skills' } }, 'sync'),
      row(running(target), { phase: 'deploying', op: { kind: 'connect' } }, 'connect'),
      row(running(target), { phase: 'stopping', op: { kind: 'disconnect' } }, 'disconnect'),
      row(null, { phase: 'error', error: { kind: 'unreachable', message: 'ssh refused' } }, 'error'),
    ]
    const { service } = transport(rows)
    expect(service.listConnections().map(({ id, reason, detail }) => ({ id, reason, detail }))).toEqual([
      { id: 'idle', reason: 'disconnected', detail: undefined },
      { id: 'test', reason: 'busy', detail: 'test' },
      { id: 'sync', reason: 'busy', detail: 'sync-skills' },
      { id: 'connect', reason: 'connecting', detail: undefined },
      { id: 'disconnect', reason: 'stopping', detail: undefined },
      { id: 'error', reason: 'error', detail: 'ssh refused' },
    ])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    for (const entry of rows)
      await expect(service.request(entry.id, '/dsh-sessions/import', {})).rejects.toThrow('不可用')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    '/elsewhere',
    '//evil.test/dsh-sessions/import',
    'http://evil.test/dsh-sessions/import',
    '/dsh-sessions/import?token=other',
    '/dsh-sessions/import/../preview',
  ])('运行时拒绝任意路径 %s，不发起网络请求', async (path) => {
    const { service } = transport([])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(service.request('dev', path as RemoteTransportPath, {})).rejects.toThrow('仅允许')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    'http://evil.test:12345/?token=launch-secret',
    'https://127.0.0.1:12345/?token=launch-secret',
    'http://127.0.0.1:12346/?token=launch-secret',
    'http://user:pass@127.0.0.1:12345/?token=launch-secret',
    'http://127.0.0.1:12345/path?token=launch-secret',
    'http://127.0.0.1:12345/?token=a&token=b',
  ])('拒绝未经确认的隧道 URL %s', async (url) => {
    const { service } = transport([row(running({ port: 12345, url }))])
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(service.listConnections()[0].reason).toBe('invalid-tunnel')
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('不可用')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([401, 500, 302])('认证返回 HTTP %s 时失败且不跟随跳转', async (status) => {
    let calls = 0
    const target = await remote((_req, res) => {
      calls += 1
      res.writeHead(status, { location: 'http://evil.test/?token=launch-secret' })
      res.end()
    })
    const { service } = transport([row(running(target))])
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow(`HTTP ${status}`)
    expect(calls).toBe(1)
  })

  it('认证 Cookie 不能跨 authority 继承', async () => {
    let calls = 0
    const target = await remote((_req, res) => {
      calls += 1
      res.writeHead(303, { location: './', 'set-cookie': `${cookie('127.0.0.1:1')}; Path=/` })
      res.end()
    })
    const { service } = transport([row(running(target))])
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('authority')
    expect(calls).toBe(1)
  })

  it('两条连接的并行请求与再次请求不缓存或串用 Cookie', async () => {
    const seen: string[] = []
    const handler = (req: IncomingMessage, res: ServerResponse) => {
      seen.push(`${req.headers.host} ${req.method} ${req.headers.cookie ?? '-'}`)
      if (req.method === 'GET') return authenticate(req, res)
      expect(req.headers.cookie).toBe(cookie(req.headers.host!))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    }
    const first = await remote(handler)
    const second = await remote(handler)
    const { service } = transport([row(running(first), {}, 'one'), row(running(second), {}, 'two')])
    await Promise.all(['one', 'two'].map((id) => service.request(id, '/dsh-sessions/import', {})))
    await service.request('one', '/dsh-sessions/preview', {})
    expect(seen.filter((entry) => entry.includes(' GET '))).toHaveLength(3)
    expect(seen.filter((entry) => entry.includes(' POST '))).toHaveLength(3)
  })

  it('认证期间断开显式失败，不能把旧 Cookie 发往新连接', async () => {
    const rows: ConnRow[] = []
    let calls = 0
    const target = await remote((req, res) => {
      calls += 1
      rows[0] = row(null)
      authenticate(req, res)
    })
    rows.push(row(running(target)))
    const { service } = transport(rows)
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('连接在传输期间发生变化')
    expect(calls).toBe(1)
    expect(service.listConnections()[0].reason).toBe('disconnected')
  })

  it('POST 期间实例身份变化不能返回伪成功', async () => {
    const rows: ConnRow[] = []
    const target = await remote((req, res) => {
      if (req.method === 'GET') return authenticate(req, res)
      rows[0] = row({ ...running(target), pid: 43 })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
    rows.push(row(running(target)))
    const { service } = transport(rows)
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('连接在传输期间发生变化')
  })

  it.each([
    [409, 'application/json', '{"error":"revision conflict"}', 'revision conflict'],
    [200, 'text/html', '<html>login</html>', '没有返回 JSON'],
    [200, 'application/json', 'not json', '无效的 JSON'],
    [307, 'application/json', '{}', '不允许跟随'],
  ])('保留远端错误而拒绝非 JSON 或接口跳转（HTTP %s）', async (status, contentType, body, expected) => {
    const target = await remote((req, res) => {
      if (req.method === 'GET') return authenticate(req, res)
      res.writeHead(status, { 'content-type': contentType, location: '/elsewhere' })
      res.end(body)
    })
    const { service } = transport([row(running(target))])
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow(expected)
  })

  it('响应长度声明和流式累积均受到上限约束', async () => {
    for (const declared of [true, false]) {
      const target = await remote((req, res) => {
        if (req.method === 'GET') return authenticate(req, res)
        res.writeHead(200, {
          'content-type': 'application/json',
          ...(declared ? { 'content-length': String(9 * 1024 * 1024) } : {}),
        })
        res.end('x'.repeat(9 * 1024 * 1024))
      })
      const { service } = transport([row(running(target))])
      await expect(service.request('dev', '/dsh-sessions/preview', {})).rejects.toThrow('字节限制')
    }
  })

  it('网络错误保留实际原因并剔除 token 与带 token URL', async () => {
    const target = { port: 12345, url: 'http://127.0.0.1:12345/?token=launch-secret' }
    const { service } = transport([row(running(target))])
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          new Error(`fetch ${target.url}`, { cause: new Error('ECONNRESET launch-secret') }),
        ),
    )
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('ECONNRESET [token]')
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.not.toThrow('launch-secret')
  })

  it.each([null, [], 'text', { toJSON: () => 'text' }, { toJSON: () => undefined }])(
    '继承 host 的 JSON 对象限制，不接受非对象序列化结果',
    async (body) => {
      const { service } = transport([])
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      await expect(service.request('dev', '/dsh-sessions/import', body)).rejects.toThrow('JSON 对象')
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each(['missing', 'domain', 'wrong-path', 'duplicate', 'wrong-location'])(
    '拒绝无效认证 Cookie 或跳转：%s',
    async (kind) => {
      let calls = 0
      const target = await remote((req, res) => {
        calls += 1
        const value = `${cookie(req.headers.host!)}; ${kind === 'wrong-path' ? 'Path=/elsewhere' : 'Path=/'}${kind === 'domain' ? '; Domain=127.0.0.1' : ''}`
        res.writeHead(303, {
          location: kind === 'wrong-location' ? 'http://evil.test/' : './',
          ...(kind === 'missing' ? {} : { 'set-cookie': kind === 'duplicate' ? [value, value] : value }),
        })
        res.end()
      })
      const { service } = transport([row(running(target))])
      await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow()
      expect(calls).toBe(1)
    },
  )

  it('保留运行中 probing 的事实，不把阶段名称误当断开', () => {
    const { service } = transport([
      row(running({ port: 12345, url: 'http://127.0.0.1:12345/?token=launch-secret' }), { phase: 'probing' }),
    ])
    expect(service.listConnections()[0].available).toBe(true)
  })

  it('实例 token 变化即使复用同一个本地端口也不能继续 POST', async () => {
    const rows: ConnRow[] = []
    let calls = 0
    const target = await remote((req, res) => {
      calls += 1
      rows[0] = row({ ...running(target), url: target.url.replace('launch-secret', 'replacement-secret') })
      authenticate(req, res)
    })
    rows.push(row(running(target)))
    const { service } = transport(rows)
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('连接在传输期间发生变化')
    expect(calls).toBe(1)
  })

  it('插件卸载时正式服务移除，已持有的引用也不能继续发送请求', async () => {
    const { service } = transport([
      row(running({ port: 12345, url: 'http://127.0.0.1:12345/?token=launch-secret' })),
    ])
    const ctx = contexts.pop()!
    await ctx.fiber.dispose()
    expect(ctx.get('remoteTransport')).toBeUndefined()
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow('连接在传输期间发生变化')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('连接清单和远端错误详情不泄露启动 token 或认证 Cookie', async () => {
    const target = await remote((req, res) => {
      if (req.method === 'GET') return authenticate(req, res)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `${target.url} launch-secret ${cookie(target.authority)}` }))
    })
    const { service } = transport([
      row(running(target), {
        phase: 'error',
        error: { kind: 'unknown', message: `${target.url} launch-secret` },
      }),
    ])
    expect(service.listConnections()[0].detail).not.toContain('launch-secret')
    const { service: connected } = transport([row(running(target))])
    try {
      await connected.request('dev', '/dsh-sessions/import', {})
      throw new Error('应拒绝远端错误')
    } catch (error) {
      expect(String(error)).toContain('HTTP 500')
      expect(String(error)).not.toContain('launch-secret')
      expect(String(error)).not.toContain('=session')
    }
  })

  it.each(['disconnect', 'invalid-json'])('导入 POST 发出后未知结果必须提醒重新预览：%s', async (kind) => {
    const target = await remote((req, res) => {
      if (req.method === 'GET') return authenticate(req, res)
      expect(req.headers['x-dsh-sessions']).toBe('1')
      if (kind === 'disconnect') {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{')
    })
    const { service } = transport([row(running(target))])
    await expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow(
      '导入可能已经提交，请重新预览确认，不要直接重试导入',
    )
  })

  it('整个认证与响应链路受同一超时约束', async () => {
    const { service } = transport([
      row(running({ port: 12345, url: 'http://127.0.0.1:12345/?token=launch-secret' })),
    ])
    const signal = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(signal.signal)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: URL, options: RequestInit) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          }),
      ),
    )
    const result = expect(service.request('dev', '/dsh-sessions/import', {})).rejects.toThrow(
      '120000ms 超时限制',
    )
    signal.abort()
    await result
  })
})
