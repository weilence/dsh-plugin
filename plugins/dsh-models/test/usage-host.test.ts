import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/usage/copilot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/usage/copilot')>()),
  readCopilotQuota: vi.fn(),
}))

vi.mock('../src/usage/codex', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/usage/codex')>()),
  readCodexQuota: vi.fn(),
}))

vi.mock('../src/mirror', () => ({
  CatalogMirror: class {
    loadPersisted() {
      return Promise.resolve()
    }
    start() {}
    stop() {}
    snapshot() {
      return { body: null, etag: null }
    }
  },
}))

import { apply, USAGE_PATH } from '../src/index'
import { CODEX_CREDENTIAL_KEY, readCodexQuota, type CodexQuota } from '../src/usage/codex'
import { COPILOT_CREDENTIAL_KEY, readCopilotQuota } from '../src/usage/copilot'

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>

function setup(resolve: (ref: string) => Promise<unknown> = async () => undefined) {
  const handlers = new Map<string, Handler>()
  const onRecordUpdated: Array<(key: string) => void> = []
  const ctx = {
    effect: (register: () => unknown) => register(),
    inject: () => {},
    on: (name: string, listener: (key: string) => void) => {
      if (name === 'credentials/record-updated') onRecordUpdated.push(listener)
    },
    get: (name: string) => (name === 'credentials' ? { resolve } : undefined),
    webServer: {
      host: '127.0.0.1',
      register: ({ path, handler }: { path: string; handler: Handler }) => {
        handlers.set(path, handler)
        return () => handlers.delete(path)
      },
    },
    logger: { info: () => {}, warn: () => {} },
  }
  apply(ctx as never)
  const request = async (url: string, method = 'GET', host = '127.0.0.1:19387') => {
    const handler = handlers.get(USAGE_PATH)
    if (!handler) throw new Error('用量路由未注册')
    const captured: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
    const res = {
      writeHead: (status: number) => {
        captured.status = status
      },
      end: (data?: Buffer) => {
        if (data) captured.body = JSON.parse(data.toString()) as Record<string, unknown>
      },
    } as unknown as ServerResponse
    await handler({ headers: { host }, method, url } as IncomingMessage, res)
    return captured
  }
  return { request, recordUpdated: (key: string) => onRecordUpdated.forEach((listener) => listener(key)) }
}

describe('Provider 用量 Host 路由', () => {
  it('拒绝错误 Host 与非 GET 请求，不查询凭据', async () => {
    const resolve = vi.fn(async () => undefined)
    const { request } = setup(resolve)
    expect((await request(`${USAGE_PATH}?provider=zai-coding-cn`, 'GET', 'example.com')).status).toBe(403)
    expect((await request(`${USAGE_PATH}?provider=zai-coding-cn`, 'POST')).status).toBe(403)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('不支持的 Provider 明确失败，不触发任意上游请求', async () => {
    const { request } = setup()
    expect(await request(`${USAGE_PATH}?provider=example`)).toMatchObject({
      status: 400,
      body: { error: expect.stringContaining('没有用量适配器') },
    })
  })

  it('智谱无凭据时返回稳定原因码，且没有密钥', async () => {
    const { request } = setup()
    expect(await request(`${USAGE_PATH}?provider=zai-coding-cn`)).toMatchObject({
      status: 200,
      body: { kind: 'unavailable', code: 'not_configured', detail: '' },
    })
  })

  it('Codex 授权变化会失效缓存，并隔离旧账号尚未完成的请求', async () => {
    const quota = (usedPct: number): CodexQuota => ({
      windows: [
        {
          kind: 'primary',
          usedPct,
          resetMs: Date.now() + 300_000,
          windowMins: 300,
        },
      ],
    })
    let finishOld!: (value: CodexQuota) => void
    const read = vi.mocked(readCodexQuota)
    read.mockReset()
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        }),
    )
    read.mockResolvedValue(quota(60))
    const { request, recordUpdated } = setup()
    const path = `${USAGE_PATH}?provider=openai-codex`
    const old = request(path)
    recordUpdated('unrelated/account')
    const concurrent = request(path)
    expect(read).toHaveBeenCalledTimes(1)
    recordUpdated(CODEX_CREDENTIAL_KEY)
    const next = await request(path)
    expect(next.body).toMatchObject({ kind: 'quota', windows: [{ usedPct: 60 }] })
    finishOld(quota(12))
    expect((await old).body).toMatchObject({
      kind: 'unavailable',
      code: 'authorization_changed',
    })
    expect((await concurrent).body).toMatchObject({ kind: 'unavailable' })
    expect((await request(path)).body).toMatchObject({ kind: 'quota', windows: [{ usedPct: 60 }] })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('Codex 默认窗口只显示时长，附加额度保留桶名称', async () => {
    const read = vi.mocked(readCodexQuota)
    read.mockReset()
    read.mockResolvedValueOnce({
      windows: (
        [
          { bucketId: 'codex', bucketName: 'Codex', kind: 'primary', windowMins: 300 },
          { bucketId: 'codex', bucketName: 'Codex', kind: 'secondary', windowMins: 10080 },
          { bucketId: 'code_review', bucketName: 'Reviews', kind: 'primary', windowMins: 300 },
        ] as const
      ).map((window) => ({ ...window, usedPct: 20, resetMs: 0 })),
    })
    const { request } = setup()
    const response = await request(`${USAGE_PATH}?provider=openai-codex`)
    expect(response.body).toMatchObject({
      kind: 'quota',
      windows: [
        { label: { kind: 'window', windowMins: 300, role: 'primary' } },
        { label: { kind: 'window', windowMins: 10080, role: 'secondary' } },
        { label: { kind: 'window', windowMins: 300, role: 'primary', bucketName: 'Reviews' } },
      ],
    })
  })

  it('Copilot 使用模型登录态的套餐额度，不读取 Billing token', async () => {
    const read = vi.mocked(readCopilotQuota)
    read.mockReset()
    read.mockResolvedValueOnce({
      remainingPct: 70,
      remaining: 210,
      entitlement: 300,
      unlimited: false,
      resetMs: null,
    })
    const resolve = vi.fn(async () => undefined)
    const { request } = setup(resolve)
    expect(await request(`${USAGE_PATH}?provider=github-copilot`)).toMatchObject({
      status: 200,
      body: {
        kind: 'quota',
        windows: [{ label: { kind: 'premiumRequests' }, usedPct: 30, remaining: 210, entitlement: 300 }],
      },
    })
    expect(read).toHaveBeenCalledOnce()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('Copilot 授权变化失效缓存，旧账号请求不得覆盖新额度', async () => {
    const read = vi.mocked(readCopilotQuota)
    read.mockReset()
    let finishOld!: (value: Awaited<ReturnType<typeof readCopilotQuota>>) => void
    read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve
        }),
    )
    read.mockResolvedValue({
      remainingPct: 25,
      remaining: 25,
      entitlement: 100,
      unlimited: false,
      resetMs: null,
    })
    const { request, recordUpdated } = setup()
    const path = `${USAGE_PATH}?provider=github-copilot`
    const old = request(path)
    recordUpdated(COPILOT_CREDENTIAL_KEY)
    expect((await request(path)).body).toMatchObject({ kind: 'quota', windows: [{ usedPct: 75 }] })
    finishOld({ remainingPct: 90, remaining: 90, entitlement: 100, unlimited: false, resetMs: null })
    expect((await old).body).toMatchObject({
      kind: 'unavailable',
      code: 'authorization_changed',
    })
    expect((await request(path)).body).toMatchObject({ kind: 'quota', windows: [{ usedPct: 75 }] })
  })
})
