import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { IMPORT_PATH, MAX_ARCHIVE_BYTES, MAX_REQUEST_BYTES, type ImportRequest } from '../src/shared'

const operations = vi.hoisted(() => ({
  previewArchive: vi.fn(),
  importArchive: vi.fn(),
}))
vi.mock('../src/archive', () => operations)

const expected = { archiveDigest: 'a'.repeat(64), cwd: '/target', sessions: { example: null } }
const payload: ImportRequest = {
  archive: Buffer.from('archive bytes').toString('base64'),
  cwd: '/target',
  trusted: true,
}
const preview = { expected }
const imported = { imported: ['example'], skipped: [], incomplete: [] }

describe('会话导入宿主路由', () => {
  let rejection: 401 | 403 | undefined
  let handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>

  async function request(
    data: unknown = payload,
    headers: Record<string, string | undefined> = {},
    method = 'POST',
    chunks?: readonly Buffer[],
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
    const handler = handlers.get(IMPORT_PATH)
    if (handler === undefined) throw new Error(`未注册 ${IMPORT_PATH}`)
    await handler(req, res)
    return result
  }

  beforeEach(() => {
    vi.resetAllMocks()
    rejection = undefined
    handlers = new Map()
    operations.previewArchive.mockResolvedValue(preview)
    operations.importArchive.mockResolvedValue(imported)
    apply({
      effect(callback: () => unknown) {
        callback()
      },
      webServer: {
        register(route: {
          path: string
          handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
        }) {
          handlers.set(route.path, route.handler)
          return () => handlers.delete(route.path)
        },
      },
      connection: { requestRejection: () => rejection },
    } as never)
  })

  it('仅注册导入路由，自动校验并使用内部版本提交，无需客户端预览', async () => {
    expect([...handlers.keys()]).toEqual([IMPORT_PATH])
    expect(await request()).toEqual({ status: 200, body: imported })
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
    rejection = status
    expect(await request()).toEqual({
      status,
      body: { error: status === 401 ? '会话导入请求未通过宿主认证' : '请求来源不允许' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('拒绝跨站、错误协议标记和方法', async () => {
    expect((await request(payload, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await request(payload, { 'x-dsh-sessions': undefined })).status).toBe(403)
    expect((await request(payload, { 'x-dsh-sessions': '0' })).status).toBe(403)
    expect((await request(payload, {}, 'GET')).status).toBe(403)
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it.each([false, undefined, 'true', 1])('可信确认必须严格等于 true（%s）', async (trusted) => {
    expect(await request({ ...payload, trusted })).toEqual({
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
      expect((await request({ ...payload, ...fields })).status).toBe(400)
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('拒绝非对象和非法 JSON 请求体', async () => {
    expect((await request(null)).status).toBe(400)
    expect((await request([])).status).toBe(400)
    expect((await request(payload, {}, 'POST', [Buffer.from('{')])).status).toBe(400)
    expect((await request(payload, {}, 'POST', [])).status).toBe(400)
    expect(operations.previewArchive).not.toHaveBeenCalled()
  })

  it('会话档案请求可显式超过其他插件默认的 2 MiB 限额', async () => {
    const archive = Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')
    expect((await request({ ...payload, archive })).status).toBe(200)
    expect(operations.previewArchive.mock.calls[0]?.[1].length).toBe(2 * 1024 * 1024)
  })

  it.each([0, 4])('同时限制 Base64 长度和解码后的档案大小（额外 %s 字符）', async (extra) => {
    const archive = 'A'.repeat(Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4 + extra)
    expect(await request({ ...payload, archive })).toEqual({
      status: 413,
      body: { error: '会话档案超过 64 MiB' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('在解析 JSON 前限制整个请求体大小', async () => {
    const chunk = Buffer.alloc(1024 * 1024)
    const chunks = Array.from({ length: Math.floor(MAX_REQUEST_BYTES / chunk.length) + 1 }, () => chunk)
    expect(await request(payload, {}, 'POST', chunks)).toEqual({
      status: 413,
      body: { error: '请求体过大' },
    })
    expect(operations.previewArchive).not.toHaveBeenCalled()
  })

  it('校验失败不提交，释放互斥状态并保留实际原因', async () => {
    operations.previewArchive.mockRejectedValueOnce(new Error('ZIP 条目路径不安全： "../escape"'))
    expect(await request()).toEqual({
      status: 500,
      body: { error: 'ZIP 条目路径不安全： "../escape"' },
    })
    expect(operations.importArchive).not.toHaveBeenCalled()
    expect((await request()).status).toBe(200)
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
    const first = request()
    await vi.waitFor(() => expect(operations.previewArchive).toHaveBeenCalledTimes(1))
    expect(operations.importArchive).not.toHaveBeenCalled()
    expect((await request()).status).toBe(409)
    expect(operations.previewArchive).toHaveBeenCalledTimes(1)
    finishPreview(preview)
    await vi.waitFor(() => expect(operations.importArchive).toHaveBeenCalledTimes(1))
    expect((await request()).status).toBe(409)
    expect(operations.previewArchive).toHaveBeenCalledTimes(1)
    expect(operations.importArchive).toHaveBeenCalledTimes(1)
    finishImport(imported)
    expect(await first).toEqual({ status: 200, body: imported })
    expect((await request()).status).toBe(200)
  })

  it('提交失败释放互斥状态并保留实际原因', async () => {
    operations.importArchive.mockRejectedValueOnce(new Error('EACCES: 目标持久化目录不可写'))
    expect(await request()).toEqual({
      status: 500,
      body: { error: 'EACCES: 目标持久化目录不可写' },
    })
    expect((await request()).status).toBe(200)
  })

  it('原样返回部分导入结果和实际失败原因', async () => {
    const partial = {
      imported: ['example'],
      skipped: ['same'],
      incomplete: ['child'],
      failure: { id: 'child', reason: 'Disk quota exceeded；close failed' },
    }
    operations.importArchive.mockResolvedValueOnce(partial)
    expect(await request()).toEqual({ status: 200, body: partial })
  })
})
