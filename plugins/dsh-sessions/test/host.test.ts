import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { MIGRATE_PATH, PRESET_PATH, PRESETS_PATH } from '../src/shared'

const operations = vi.hoisted(() => ({
  migrateSession: vi.fn(),
  migratePreset: vi.fn(),
  listPresets: vi.fn(),
}))
// 路由层只测认证、参数与互斥；操作语义由 operations.test.ts 走真实实现覆盖。
vi.mock('../src/move', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migrateSession: operations.migrateSession,
}))
vi.mock('../src/preset', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migratePreset: operations.migratePreset,
  listPresets: operations.listPresets,
}))

interface Harness {
  handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
  rejection: 401 | 403 | undefined
  request(
    data?: unknown,
    headers?: Record<string, string | undefined>,
    method?: string,
    chunks?: readonly Buffer[],
    path?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }>
}

function harness(): Harness {
  const state: Harness = {
    handlers: new Map(),
    rejection: undefined,
    async request(
      data = { sessionId: 's', workspaceId: 'w' },
      headers = {},
      method = 'POST',
      chunks,
      path = MIGRATE_PATH,
    ) {
      const result: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
      const req = {
        method,
        headers: { host: '127.0.0.1:19387', 'x-dsh-sessions': '1', ...headers },
        async *[Symbol.asyncIterator]() {
          if (chunks !== undefined) yield* chunks
          else yield Buffer.from(JSON.stringify(data))
        },
      } as unknown as IncomingMessage
      const res = {
        writeHead(status: number) {
          result.status = status
        },
        end(bytes: Buffer) {
          result.body = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
        },
      } as unknown as ServerResponse
      const handler = state.handlers.get(path)
      if (handler === undefined) throw new Error(`未注册 ${path}`)
      await handler(req, res)
      return result
    },
  }
  apply({
    effect(callback: () => unknown) {
      callback()
    },
    webServer: {
      register(route: {
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) {
        state.handlers.set(route.path, route.handler)
        return () => state.handlers.delete(route.path)
      },
    },
    connection: { requestRejection: () => state.rejection },
  } as never)
  return state
}

describe('宿主路由', () => {
  let api: Harness
  beforeEach(() => {
    vi.resetAllMocks()
    api = harness()
    operations.migrateSession.mockResolvedValue({ ok: true, moved: true, attached: true })
    operations.migratePreset.mockResolvedValue({ migrated: true, newPreset: 'coder' })
    operations.listPresets.mockResolvedValue(['coder', 'writer'])
  })

  it('注册迁移与预设三条路由', () => {
    expect([...api.handlers.keys()].sort()).toEqual([MIGRATE_PATH, PRESETS_PATH, PRESET_PATH].sort())
  })

  it('认证与协议拦截对所有路由一致', async () => {
    for (const path of [MIGRATE_PATH, PRESETS_PATH, PRESET_PATH]) {
      api.rejection = 401
      expect(await api.request({}, {}, 'POST', undefined, path)).toEqual({
        status: 401,
        body: { error: '会话管理请求未通过宿主认证' },
      })
      api.rejection = 403
      expect(await api.request({}, {}, 'POST', undefined, path)).toEqual({
        status: 403,
        body: { error: '请求来源不允许' },
      })
      api.rejection = undefined
      expect(
        (await api.request({}, { 'sec-fetch-site': 'cross-site' }, 'POST', undefined, path)).status,
      ).toBe(403)
      expect((await api.request({}, { 'x-dsh-sessions': '0' }, 'POST', undefined, path)).status).toBe(403)
      expect((await api.request({}, {}, 'GET', undefined, path)).status).toBe(403)
    }
    expect(operations.migrateSession).not.toHaveBeenCalled()
    expect(operations.migratePreset).not.toHaveBeenCalled()
    expect(operations.listPresets).not.toHaveBeenCalled()
  })

  it('拒绝非对象和非法 JSON 请求体', async () => {
    expect((await api.request(null)).status).toBe(400)
    expect((await api.request([])).status).toBe(400)
    expect((await api.request({}, {}, 'POST', [Buffer.from('{')])).status).toBe(400)
    expect((await api.request({}, {}, 'POST', [])).status).toBe(400)
    expect(operations.migrateSession).not.toHaveBeenCalled()
  })

  it('拒绝缺失的会话、工作区或预设参数', async () => {
    expect(
      await api.request({ sessionId: 's', workspaceId: '' }, {}, 'POST', undefined, MIGRATE_PATH),
    ).toEqual({
      status: 400,
      body: { error: '缺少有效的 workspaceId' },
    })
    expect(await api.request({ sessionId: 's', toPreset: '' }, {}, 'POST', undefined, PRESET_PATH)).toEqual({
      status: 400,
      body: { error: '缺少有效的 toPreset' },
    })
    expect(operations.migrateSession).not.toHaveBeenCalled()
    expect(operations.migratePreset).not.toHaveBeenCalled()
  })

  it('迁移与预设结果原样返回，预设清单走只读路由', async () => {
    expect(
      await api.request({ sessionId: 's', workspaceId: 'w' }, {}, 'POST', undefined, MIGRATE_PATH),
    ).toEqual({
      status: 200,
      body: { ok: true, moved: true, attached: true },
    })
    expect(
      await api.request({ sessionId: 's', toPreset: 'coder' }, {}, 'POST', undefined, PRESET_PATH),
    ).toEqual({
      status: 200,
      body: { migrated: true, newPreset: 'coder' },
    })
    expect(await api.request({}, {}, 'POST', undefined, PRESETS_PATH)).toEqual({
      status: 200,
      body: { presets: ['coder', 'writer'] },
    })
  })

  it('操作协议错误保留状态码与实际原因，失败后互斥释放', async () => {
    operations.migrateSession.mockRejectedValueOnce(new Error('目标工作区不存在，请重新选择'))
    expect(
      await api.request({ sessionId: 's', workspaceId: 'w' }, {}, 'POST', undefined, MIGRATE_PATH),
    ).toEqual({ status: 500, body: { error: '目标工作区不存在，请重新选择' } })
    expect(
      (await api.request({ sessionId: 's', workspaceId: 'w' }, {}, 'POST', undefined, MIGRATE_PATH)).status,
    ).toBe(200)
  })

  it('全部变更路由共用存储互斥，进行中请求一律 409', async () => {
    let release!: () => void
    operations.migrateSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, moved: true, attached: true })
        }),
    )
    const first = api.request({ sessionId: 's', workspaceId: 'w' }, {}, 'POST', undefined, MIGRATE_PATH)
    await vi.waitFor(() => expect(operations.migrateSession).toHaveBeenCalledTimes(1))
    expect(
      (await api.request({ sessionId: 's', toPreset: 'p' }, {}, 'POST', undefined, PRESET_PATH)).status,
    ).toBe(409)
    release()
    expect((await first).status).toBe(200)
    expect(
      (await api.request({ sessionId: 's', workspaceId: 'w' }, {}, 'POST', undefined, MIGRATE_PATH)).status,
    ).toBe(200)
  })
})
