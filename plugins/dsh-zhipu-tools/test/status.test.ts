/** 端点状态与写入路由：假 ctx/webServer + 真 dshHomePath / 真临时 patch 文件的集成往返。 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  APPLY_WEB_CONFIG_PATH,
  ENDPOINT_STATUS_PATH,
  type ApplyWebConfigBody,
  type EndpointStatusView,
} from '../src/shared'

const harnessState = vi.hoisted(() => ({ home: '' }))

vi.mock('@deepseek-ai/dsh-home-paths', () => ({
  dshHomePath: (...segments: string[]) => [harnessState.home, ...segments].join('/'),
}))

import { apply } from '../src/index'

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

function fakeReq(
  path: string,
  method: string,
  body: unknown = {},
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  const stream = (async function* () {
    yield payload
  })()
  return {
    url: path,
    method,
    headers: { host: '127.0.0.1', ...headers },
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, body: {} }
  const chunks: Buffer[] = []
  let settled = false
  let resolveDone: (capture: CapturedResponse) => void
  const done = new Promise<CapturedResponse>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    writableEnded: false,
    headersSent: false,
    writableFinished: false,
    writeHead(status: number) {
      captured.status = status
    },
    write(chunk: Buffer) {
      chunks.push(Buffer.from(chunk))
    },
    end(payload?: Buffer) {
      if (payload !== undefined) chunks.push(Buffer.from(payload))
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        captured.body = {}
      }
      settled = true
      resolveDone!(captured)
    },
    destroy() {
      settled = true
      resolveDone!(captured)
    },
    on() {},
  }
  return { res: res as unknown as ServerResponse, done }
}

async function makeHarness(
  resolve: (name: string) => Promise<unknown>,
  options: { patchPath?: string } = {},
): Promise<{
  request(
    path: string,
    method?: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<CapturedResponse>
  errors: string[]
}> {
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const disposers: (() => unknown)[] = []
  const errors: string[] = []
  const ctx = {
    credentials: { resolve },
    get: (key: string) =>
      key === 'profileContext' && options.patchPath !== undefined
        ? { patchPath: options.patchPath }
        : undefined,
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
    request: async (path, method = 'GET', body = undefined, headers = {}) => {
      const handler = registrations.get(path)
      if (handler === undefined) throw new Error(`路由未注册：${path}`)
      const { res, done } = fakeRes()
      await handler(fakeReq(path, method, body, headers), res)
      return done
    },
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
  it('凭据在场：返回端点地址、凭据状态与 patch 基线', async () => {
    const harness = await makeHarness(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined,
    )
    const capture = await harness.request(ENDPOINT_STATUS_PATH)
    const view = capture.body as unknown as EndpointStatusView
    expect(capture.status).toBe(200)
    expect(view.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(view.credential).toEqual({ configured: true })
    expect(view.fetchBackend).toBe('zhipu-reader')
    expect(view.patchMtimeMs).toBeNull()
  })

  it('凭据缺席：端点照常监听，面板给缺失事实', async () => {
    const harness = await makeHarness(async () => undefined)
    const capture = await harness.request(ENDPOINT_STATUS_PATH)
    const view = capture.body as unknown as EndpointStatusView
    expect(view.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(view.credential.configured).toBe(false)
    expect(harness.errors[0]).toContain('未配置')
  })

  it('凭据解析故障：原文透传到面板，不拖垮其余状态', async () => {
    const harness = await makeHarness(async () => {
      throw new Error('存储被锁')
    })
    const capture = await harness.request(ENDPOINT_STATUS_PATH)
    const view = capture.body as unknown as EndpointStatusView
    expect(capture.status).toBe(200)
    expect(view.credential).toEqual({ configured: false, failure: expect.stringContaining('存储被锁') })
  })

  it('端点启动失败（状态文件损坏）：失败原样进面板，状态路由照常', async () => {
    await writeFile(join(root, 'dsh-zhipu-tools.json'), 'garbage', 'utf8')
    const harness = await makeHarness(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined,
    )
    const capture = await harness.request(ENDPOINT_STATUS_PATH)
    const view = capture.body as unknown as EndpointStatusView
    expect(view.baseUrl).toBeNull()
    expect(view.failure).toContain('不是有效 JSON')
    expect(harness.errors[0]).toContain('启动失败')
  })

  it('仅接受同源 GET：POST 或跨站标记拒 403', async () => {
    const harness = await makeHarness(async () => undefined)
    expect((await harness.request(ENDPOINT_STATUS_PATH, 'POST')).status).toBe(403)
    const capture = await harness.request(ENDPOINT_STATUS_PATH, 'GET', undefined, {
      'sec-fetch-site': 'cross-site',
    })
    expect(capture.status).toBe(403)
  })
})

describe('写入路由 apply-web-config', () => {
  const patchPath = (): string => join(root, 'cordis.patch.yml')

  const INITIAL_PATCH = [
    '# 我的 patch',
    '- id: agent-default-model',
    '  config:',
    '    provider: zai-coding-cn',
    '- id: web-deepseek-api',
    '  config:',
    '    apiKeyEnv: DEEPSEEK_API_KEY',
    '    baseURL: http://127.0.0.1:1',
    '    model: deepseek-v4-flash',
    '- id: web',
    '  config:',
    '    searchProvider: deepseek-search-api',
  ].join('\n')

  it('成功 upsert：自家键更新、未知键与注释保留、幂等', async () => {
    await writeFile(patchPath(), INITIAL_PATCH, 'utf8')
    const mtime = (await stat(patchPath())).mtimeMs
    const harness = await makeHarness(
      async (name) => (name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined),
      { patchPath: patchPath() },
    )
    const first = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST', { expectedMtimeMs: mtime })
    expect(first.status).toBe(200)
    const text = await readFile(patchPath(), 'utf8')
    expect(text).toContain('# 我的 patch')
    expect(text).toContain('provider: zai-coding-cn')
    expect(text).toContain('apiKeyEnv: ZAI_CODING_CN_API_KEY')
    expect(text).not.toContain('DEEPSEEK_API_KEY')
    expect(text).toMatch(/baseURL: http:\/\/127\.0\.0\.1:\d+/)
    expect(text).toContain('model: deepseek-v4-flash')
    expect(text).toContain('fetchProvider: deepseek-fetch-api')

    // 幂等：基线缺失（不传 mtime）也放行，同样内容再写一次文本不变。
    const afterFirst = text
    const second = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST', {})
    expect(second.status).toBe(200)
    expect(await readFile(patchPath(), 'utf8')).toBe(afterFirst)
  })

  it('mtime 基线不符拒 409，文件不被触碰', async () => {
    await writePatch(patchPath())
    const harness = await makeHarness(
      async (name) => (name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined),
      { patchPath: patchPath() },
    )
    const capture = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST', { expectedMtimeMs: 1 })
    expect(capture.status).toBe(409)
    expect(JSON.stringify(capture.body)).toContain('已被外部修改')
    expect(await readFile(patchPath(), 'utf8')).toBe(INITIAL_PATCH)
  })

  it('端点未监听（状态文件损坏）与 profile 上下文缺席分别明确报错', async () => {
    await writeFile(join(root, 'dsh-zhipu-tools.json'), 'garbage', 'utf8')
    const down = await makeHarness(async () => undefined, { patchPath: patchPath() })
    const downCapture = await down.request(APPLY_WEB_CONFIG_PATH, 'POST', {})
    expect(downCapture.status).toBe(409)
    expect(JSON.stringify(downCapture.body)).toContain('端点未在监听')

    // 修好状态文件让第二个 harness 的端点正常启动， isolating「profile 缺席」这一个问题。
    await rm(join(root, 'dsh-zhipu-tools.json'), { force: true })
    const noProfile = await makeHarness(async (name) =>
      name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined,
    )
    const noProfileCapture = await noProfile.request(APPLY_WEB_CONFIG_PATH, 'POST', {})
    expect(noProfileCapture.status).toBe(500)
    expect(JSON.stringify(noProfileCapture.body)).toContain('无法定位 profile patch')
  })

  it('信任边界：跨站标记拒 403，非 POST 拒 405', async () => {
    const harness = await makeHarness(async () => undefined, { patchPath: patchPath() })
    const crossSite = await harness.request(
      APPLY_WEB_CONFIG_PATH,
      'POST',
      {},
      { 'sec-fetch-site': 'cross-site' },
    )
    expect(crossSite.status).toBe(403)
    expect((await harness.request(APPLY_WEB_CONFIG_PATH, 'GET')).status).toBe(405)
  })

  async function writePatch(path: string): Promise<void> {
    await writeFile(path, INITIAL_PATCH, 'utf8')
  }
})
