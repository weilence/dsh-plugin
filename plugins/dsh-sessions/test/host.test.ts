import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import {
  BATCH_PATH,
  DELETE_PATH,
  IMPORT_PATH,
  MAX_ARCHIVE_BYTES,
  MAX_REQUEST_BYTES,
  MIGRATE_PATH,
  PRESET_PATH,
  PRESETS_PATH,
  type ImportRequest,
} from '../src/shared'

const operations = vi.hoisted(() => ({
  previewArchive: vi.fn(),
  importArchive: vi.fn(),
  deleteSessionCascade: vi.fn(),
  migrateSession: vi.fn(),
  migratePreset: vi.fn(),
  listPresets: vi.fn(),
  runBatch: vi.fn(),
}))
// 路由层只测认证、参数与互斥；操作语义由 operations.test.ts 走真实实现覆盖。
vi.mock('../src/archive', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  previewArchive: operations.previewArchive,
  importArchive: operations.importArchive,
}))
vi.mock('../src/batch', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runBatch: operations.runBatch,
}))
vi.mock('../src/delete', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteSessionCascade: operations.deleteSessionCascade,
}))
vi.mock('../src/move', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migrateSession: operations.migrateSession,
}))
vi.mock('../src/preset', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migratePreset: operations.migratePreset,
  listPresets: operations.listPresets,
}))

const expected = { archiveDigest: 'a'.repeat(64), cwd: '/target', sessions: { example: null } }
const payload: ImportRequest = {
  archive: Buffer.from('archive bytes').toString('base64'),
  cwd: '/target',
  trusted: true,
}
const preview = { expected }
const imported = { imported: ['example'], skipped: [], incomplete: [] }

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
    async request(data = payload, headers = {}, method = 'POST', chunks, path = IMPORT_PATH) {
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

describe('宿主路由注册与导入', () => {
  let api: Harness
  beforeEach(() => {
    vi.resetAllMocks()
    api = harness()
    operations.previewArchive.mockResolvedValue(preview)
    operations.importArchive.mockResolvedValue(imported)
  })

  it('注册全部六条路由', () => {
    expect([...api.handlers.keys()]).toEqual([
      IMPORT_PATH,
      DELETE_PATH,
      MIGRATE_PATH,
      PRESETS_PATH,
      PRESET_PATH,
      BATCH_PATH,
    ])
  })

  it('导入自动校验并使用内部版本提交，无需客户端预览', async () => {
    expect(await api.request()).toEqual({ status: 200, body: imported })
    expect(operations.previewArchive).toHaveBeenCalledWith(
      expect.anything(),
      Buffer.from('archive bytes'),
      '/target',
    )
    expect(operations.importArchive).toHaveBeenCalledWith(
      operations.previewArchive.mock.calls[0]![0],
      Buffer.from('archive bytes'),
      '/target',
      expected,
    )
    expect(operations.previewArchive.mock.invocationCallOrder[0]).toBeLessThan(
      operations.importArchive.mock.invocationCallOrder[0]!,
    )
  })

  it.each([401, 403] as const)('必须通过宿主认证（%s）', async (status) => {
    api.rejection = status
    expect(await api.request()).toEqual({
      status,
      body: { error: status === 401 ? '会话管理请求未通过宿主认证' : '请求来源不允许' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('拒绝跨站、错误协议标记和方法', async () => {
    expect((await api.request(payload, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await api.request(payload, { 'x-dsh-sessions': undefined })).status).toBe(403)
    expect((await api.request(payload, { 'x-dsh-sessions': '0' })).status).toBe(403)
    expect((await api.request(payload, {}, 'GET')).status).toBe(403)
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it.each([false, undefined, 'true', 1])('可信确认必须严格等于 true（%s）', async (trusted) => {
    expect(await api.request({ ...payload, trusted })).toEqual({
      status: 400,
      body: { error: '请先确认档案来源可信；恢复后的历史权限和指令可能生效' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('拒绝缺少档案或工作目录，Base64 不容忍静默损坏', async () => {
    for (const fields of [
      { archive: '' },
      { archive: 42 },
      { archive: '%%%not-base64' },
      { archive: payload.archive + '\n' },
      { cwd: '' },
      { cwd: undefined },
    ])
      expect((await api.request({ ...payload, ...fields })).status).toBe(400)
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('拒绝非对象和非法 JSON 请求体', async () => {
    expect((await api.request(null)).status).toBe(400)
    expect((await api.request([])).status).toBe(400)
    expect((await api.request(payload, {}, 'POST', [Buffer.from('{')])).status).toBe(400)
    expect((await api.request(payload, {}, 'POST', [])).status).toBe(400)
    expect(operations.previewArchive).not.toHaveBeenCalled()
  })

  it('会话档案请求可显式超过其他插件默认的 2 MiB 限额', async () => {
    const archive = Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')
    expect((await api.request({ ...payload, archive })).status).toBe(200)
    expect(operations.previewArchive.mock.calls[0]?.[1].length).toBe(2 * 1024 * 1024)
  })

  it.each([0, 4])('同时限制 Base64 长度和解码后的档案大小（额外 %s 字符）', async (extra) => {
    const archive = 'A'.repeat(Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + extra)
    expect(await api.request({ ...payload, archive })).toEqual({
      status: 413,
      body: { error: '会话档案超过 64 MiB' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('在解析 JSON 前限制整个请求体大小', async () => {
    const chunk = Buffer.alloc(1024 * 1024)
    const chunks = Array.from({ length: Math.floor(MAX_REQUEST_BYTES / chunk.length) + 1 }, () => chunk)
    expect(await api.request(payload, {}, 'POST', chunks)).toEqual({
      status: 413,
      body: { error: '请求体过大' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
  })

  it('校验失败不提交，释放互斥状态并保留实际原因', async () => {
    operations.previewArchive.mockRejectedValueOnce(new Error('ZIP 条目路径不安全： "../escape"'))
    expect(await api.request()).toEqual({
      status: 500,
      body: { error: 'ZIP 条目路径不安全： "../escape"' },
    })
    expect(operations.importArchive).not.toHaveBeenCalled()
    expect((await api.request()).status).toBe(200)
  })

  it('校验和提交串行执行且共用互斥锁，并发请求不得进入任一阶段', async () => {
    let finishPreview: (value: typeof preview) => void = () => {
      throw new Error('尚未开始校验')
    }
    let finishImport: (value: typeof imported) => void = () => {
      throw new Error('尚未开始提交')
    }
    operations.previewArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreview = resolve
        }),
    )
    operations.importArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishImport = resolve
        }),
    )
    const first = api.request()
    await vi.waitFor(() => expect(operations.previewArchive).toHaveBeenCalledTimes(1))
    expect(operations.importArchive).not.toHaveBeenCalled()
    expect((await api.request()).status).toBe(409)
    expect(operations.previewArchive).toHaveBeenCalledTimes(1)
    finishPreview(preview)
    await vi.waitFor(() => expect(operations.importArchive).toHaveBeenCalledTimes(1))
    expect((await api.request()).status).toBe(409)
    expect(operations.previewArchive).toHaveBeenCalledTimes(1)
    expect(operations.importArchive).toHaveBeenCalledTimes(1)
    finishImport(imported)
    expect(await first).toEqual({ status: 200, body: imported })
    expect((await api.request()).status).toBe(200)
  })

  it('提交失败释放互斥状态并保留实际原因', async () => {
    operations.importArchive.mockRejectedValueOnce(new Error('EACCES: 目标持久化目录不可写'))
    expect(await api.request()).toEqual({
      status: 500,
      body: { error: 'EACCES: 目标持久化目录不可写' },
    })
    expect((await api.request()).status).toBe(200)
  })

  it('原样返回部分导入结果和实际失败原因', async () => {
    const partial = {
      imported: ['example'],
      skipped: ['same'],
      incomplete: ['child'],
      failure: { id: 'child', reason: 'Disk quota exceeded；close failed' },
    }
    operations.importArchive.mockResolvedValueOnce(partial)
    expect(await api.request()).toEqual({ status: 200, body: partial })
  })
})

describe('删除、迁移与预设路由', () => {
  let api: Harness
  beforeEach(() => {
    vi.resetAllMocks()
    api = harness()
    operations.deleteSessionCascade.mockResolvedValue({
      filesRemoved: true,
      archiveCleared: true,
      deletedSubagents: [],
    })
    operations.migrateSession.mockResolvedValue({ ok: true, moved: true, attached: true })
    operations.migratePreset.mockResolvedValue({ migrated: true, newPreset: 'coder' })
    operations.listPresets.mockResolvedValue(['coder', 'writer'])
    operations.runBatch.mockResolvedValue([{ sessionId: 's1', ok: true, cascaded: true }])
  })

  it('认证与协议拦截对所有操作路由一致', async () => {
    for (const path of [DELETE_PATH, MIGRATE_PATH, PRESETS_PATH, PRESET_PATH, BATCH_PATH]) {
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
      expect((await api.request({}, { 'x-dsh-sessions': '0' }, 'POST', undefined, path)).status).toBe(403)
      expect((await api.request({}, {}, 'GET', undefined, path)).status).toBe(403)
    }
    expect(operations.deleteSessionCascade).not.toHaveBeenCalled()
    expect(operations.migrateSession).not.toHaveBeenCalled()
    expect(operations.migratePreset).not.toHaveBeenCalled()
    expect(operations.listPresets).not.toHaveBeenCalled()
    expect(operations.runBatch).not.toHaveBeenCalled()
  })

  it('拒绝缺失的会话、工作区或预设参数', async () => {
    expect(await api.request({ sessionId: '' }, {}, 'POST', undefined, DELETE_PATH)).toEqual({
      status: 400,
      body: { error: '缺少有效的 sessionId' },
    })
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
    expect(operations.deleteSessionCascade).not.toHaveBeenCalled()
    expect(operations.migrateSession).not.toHaveBeenCalled()
    expect(operations.migratePreset).not.toHaveBeenCalled()
  })

  it('级联删除结果原样返回', async () => {
    const outcome = {
      filesRemoved: true,
      archiveCleared: true,
      deletedSubagents: ['child1'],
    }
    operations.deleteSessionCascade.mockResolvedValueOnce(outcome)
    expect(await api.request({ sessionId: 'root' }, {}, 'POST', undefined, DELETE_PATH)).toEqual({
      status: 200,
      body: outcome,
    })
    expect(operations.deleteSessionCascade).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(String),
      'root',
    )
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

  it('批量请求体透传给编排器并原样返回逐项结果', async () => {
    const items = [
      {
        sessionId: 'root',
        ok: true,
        result: { filesRemoved: true, archiveCleared: true, deletedSubagents: ['child'] },
      },
      { sessionId: 'child', ok: true, cascaded: true },
      { sessionId: 'bad', ok: false, error: '会话仍加载在宿主内存中' },
    ]
    operations.runBatch.mockResolvedValueOnce(items)
    const request = { action: 'delete', sessionIds: ['root', 'child', 'bad'], payload: {} }
    expect(await api.request(request, {}, 'POST', undefined, BATCH_PATH)).toEqual({
      status: 200,
      body: items,
    })
    expect(operations.runBatch).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.any(String),
      request,
    )
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
    operations.deleteSessionCascade.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ filesRemoved: true, archiveCleared: true, deletedSubagents: [] })
        }),
    )
    const first = api.request({ sessionId: 's' }, {}, 'POST', undefined, DELETE_PATH)
    await vi.waitFor(() => expect(operations.deleteSessionCascade).toHaveBeenCalledTimes(1))
    for (const path of [DELETE_PATH, MIGRATE_PATH, PRESET_PATH, BATCH_PATH]) {
      const body =
        path === MIGRATE_PATH
          ? { sessionId: 's', workspaceId: 'w' }
          : path === BATCH_PATH
            ? { action: 'delete', sessionIds: ['s'] }
            : { sessionId: 's', toPreset: 'p' }
      expect((await api.request(body, {}, 'POST', undefined, path)).status).toBe(409)
    }
    release()
    expect((await first).status).toBe(200)
    expect((await api.request({ sessionId: 's' }, {}, 'POST', undefined, DELETE_PATH)).status).toBe(200)
  })
})
