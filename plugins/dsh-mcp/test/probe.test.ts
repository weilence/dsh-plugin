/** probe：保存前 initialize 握手探测（stdio 子进程 / HTTP 端点）。 */

import { createServer, type RequestListener, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probeConfig } from '../src/probe'
import type { McpConfigDraft } from '../src/shared'
import { stdioConfig, STUB_INITIALIZER } from './stub'

const SLOW_MS = 5000

const httpConfig = (url: string): McpConfigDraft => ({
  transport: 'streamable-http',
  serverName: 'stub',
  url,
})

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

async function listen(handler: RequestListener): Promise<Server> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return server
}

const urlOf = (server: Server): string => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`

describe('probeConfig · stdio', () => {
  it('应答 initialize 即通过', async () => {
    expect(await probeConfig(stdioConfig(STUB_INITIALIZER), SLOW_MS)).toEqual({ ok: true })
  })

  it('提前退出时带 exit 码与 stderr 尾部', async () => {
    const outcome = await probeConfig(
      stdioConfig('process.stderr.write("boom\\n"); setTimeout(() => process.exit(3), 50)'),
      SLOW_MS,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('exit 3')
    expect(outcome.error).toContain('boom')
  })

  it('超时无应答报握手超时', async () => {
    const outcome = await probeConfig(stdioConfig('process.stdin.resume()'), 300)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('握手超时')
  })

  it('命令不存在报无法启动', async () => {
    const outcome = await probeConfig(
      { transport: 'stdio', serverName: 'x', command: 'no-such-cmd-dsh-mcp' },
      SLOW_MS,
    )
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('无法启动')
  })
})

describe('probeConfig · streamable-http', () => {
  it('JSON 应答 initialize 即通过，且请求是 POST initialize', async () => {
    let seen = ''
    const server = await listen((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        seen = `${req.method} ${body}`
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }))
      })
    })
    const outcome = await probeConfig(httpConfig(urlOf(server)), SLOW_MS)
    expect(outcome).toEqual({ ok: true })
    expect(seen).toContain('POST')
    expect(seen).toContain('"method":"initialize"')
  })

  it('SSE 流推送应答即通过（不等长连接结束）', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n\n`)
    })
    const outcome = await probeConfig(httpConfig(urlOf(server)), SLOW_MS)
    expect(outcome).toEqual({ ok: true })
  })

  it('非 2xx 报 HTTP 状态', async () => {
    const server = await listen((req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
    })
    const outcome = await probeConfig(httpConfig(urlOf(server)), SLOW_MS)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('HTTP 404')
  })

  it('应答不是 initialize 的 JSON-RPC 应答时失败', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"hello":"world"}')
    })
    const outcome = await probeConfig(httpConfig(urlOf(server)), SLOW_MS)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('不是 initialize 的 JSON-RPC 应答')
  })

  it('SSE 流无应答超时', async () => {
    const server = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
    })
    const outcome = await probeConfig(httpConfig(urlOf(server)), 300)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('握手超时')
  })

  it('连接被拒时报无法连接', async () => {
    const server = await listen((req, res) => {
      res.end('{}')
    })
    const url = urlOf(server)
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    const outcome = await probeConfig(httpConfig(url), SLOW_MS)
    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('无法连接')
  })
})
