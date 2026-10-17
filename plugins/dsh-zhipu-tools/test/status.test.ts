/** 端点状态路由：假 ctx/webServer + 真 dshHomePath 落临时目录的集成往返。 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ENDPOINT_STATUS_PATH, type EndpointStatusView } from '../src/shared'

const harnessState = vi.hoisted(() => ({ home: '' }))

vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  dshHomePath: (...segments: string[]) => [harnessState.home, ...segments].join('/'),
}))

import { apply } from '../src/index'

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

function fakeReq(method: string, headers: Record<string, string | string[] | undefined>): IncomingMessage {
  return { method, url: ENDPOINT_STATUS_PATH, headers } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, body: {} }
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(payload?: Buffer) {
      try {
        captured.body = JSON.parse((payload ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>
      } catch {
        captured.body = {}
      }
    },
  } as unknown as ServerResponse
  return { res, done: Promise.resolve(captured) }
}

async function makeHarness(resolve: (name: string) => Promise<unknown>): Promise<{
  request(method: string, headers?: Record<string, string | string[] | undefined>): Promise<CapturedResponse>
  pluginCalls: number
  errors: string[]
}> {
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const disposers: (() => unknown)[] = []
  let pluginCalls = 0
  const errors: string[] = []
  const ctx = {
    credentials: { resolve },
    plugin: async () => {
      pluginCalls += 1
    },
    effect: (register: () => unknown) => {
      const dispose = register() as () => unknown
      disposers.push(dispose)
      return dispose
    },
    webServer: {
      host: '127.0.0.1',
      register(options: {
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) {
        registrations.set(options.path, options.handler)
        return () => registrations.delete(options.path)
      },
    },
    get: () => undefined,
    logger: {
      error: (message: string) => errors.push(message),
      info: () => {},
    },
  }
  await apply(ctx as never)
  closers.push(async () => {
    for (const dispose of disposers) await dispose()
  })
  return {
    request: async (method, headers = {}) => {
      const handler = registrations.get(ENDPOINT_STATUS_PATH)
      if (handler === undefined) throw new Error('状态路由未注册')
      const { res, done } = fakeRes()
      await handler(fakeReq(method, { host: '127.0.0.1', ...headers }), res)
      return done
    },
    pluginCalls,
    errors,
  }
}

let root: string
const closers: Array<() => Promise<void>> = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-zhipu-status-'))
  harnessState.home = root
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await Promise.allSettled(closers.splice(0).map((close) => close()))
  await rm(root, { recursive: true, force: true })
})

describe('端点状态路由', () => {
  it('凭据在场：返回端点地址、凭据与 MCP 挂载结果', async () => {
    const harness = await makeHarness(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined,
    )
    const capture = await harness.request('GET')
    const view = capture.body as unknown as EndpointStatusView
    expect(capture.status).toBe(200)
    expect(view.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(view.token).toMatch(/^[0-9a-f]{32}$/)
    expect(view.credential).toEqual({ configured: true })
    expect(view.fetchBackend).toBe('zhipu-reader')
    expect(view.mcp).toEqual([
      { server: 'zhipu_search', mounted: true },
      { server: 'zhipu_reader', mounted: true },
    ])
    expect(harness.pluginCalls).toBe(2)
  })

  it('凭据缺席：端点照常、MCP 不挂载、面板给缺失事实', async () => {
    const harness = await makeHarness(async () => undefined)
    const capture = await harness.request('GET')
    const view = capture.body as unknown as EndpointStatusView
    expect(view.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(view.token).toMatch(/^[0-9a-f]{32}$/)
    expect(view.credential.configured).toBe(false)
    expect(view.mcp).toEqual([
      { server: 'zhipu_search', mounted: false },
      { server: 'zhipu_reader', mounted: false },
    ])
    expect(harness.pluginCalls).toBe(0)
    expect(harness.errors[0]).toContain('未配置')
  })

  it('凭据解析故障：原文透传到面板，不拖垮其余状态', async () => {
    const harness = await makeHarness(async () => {
      throw new Error('存储被锁')
    })
    const capture = await harness.request('GET')
    const view = capture.body as unknown as EndpointStatusView
    expect(capture.status).toBe(200)
    expect(view.credential).toEqual({ configured: false, failure: expect.stringContaining('存储被锁') })
  })

  it('端点启动失败（状态文件损坏）：失败原样进面板，MCP 不受牵连', async () => {
    await writeFile(join(root, 'dsh-zhipu-tools.json'), 'garbage', 'utf8')
    const harness = await makeHarness(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined,
    )
    const capture = await harness.request('GET')
    const view = capture.body as unknown as EndpointStatusView
    expect(view.baseUrl).toBeNull()
    expect(view.failure).toContain('不是有效 JSON')
    expect(view.mcp).toEqual([
      { server: 'zhipu_search', mounted: true },
      { server: 'zhipu_reader', mounted: true },
    ])
    expect(harness.errors[0]).toContain('启动失败')
  })

  it('仅接受同源 GET：POST 或跨站标记拒 403', async () => {
    const harness = await makeHarness(async () => undefined)
    expect((await harness.request('POST')).status).toBe(403)
    expect((await harness.request('GET', { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await harness.request('GET', { host: 'evil.example' })).status).toBe(403)
  })
})
