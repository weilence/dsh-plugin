import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { RemoteEngine, type EngineDeps } from '../../dsh-remote/src/engine'
import { RemoteTransportService } from '../../dsh-remote/src/transport'
import type { ConnRow } from '../../dsh-remote/src/shared'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import { EXPORT_PATH, IMPORT_PATH, LIST_PATH, PREVIEW_PATH, REMOTES_PATH, TRANSFER_PATH } from '../src/shared'

const operations = vi.hoisted(() => ({
  exportArchive: vi.fn(),
  previewArchive: vi.fn(),
  importArchive: vi.fn(),
}))
vi.mock('../src/archive', () => operations)

const expected = { archiveDigest: 'a'.repeat(64), cwd: '/target', sessions: { example: null } }
const payload = {
  archive: Buffer.from('archive bytes').toString('base64'),
  cwd: '/target',
  expected,
  trusted: true,
}
const preview = { expected, sessions: [{ id: 'example', eventCount: 0, status: 'new' }], warnings: [] }
const imported = { imported: ['example'], skipped: [], incomplete: [] }

describe('会话迁移宿主路由', () => {
  let rejection: 401 | 403 | undefined
  let handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
  let transport: { listConnections: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> } | undefined

  async function request(
    path: string,
    data?: unknown,
    headers: Record<string, string | undefined> = {},
    method = data === undefined ? 'GET' : 'POST',
  ) {
    const result: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
    const req = {
      method,
      headers: { host: '127.0.0.1:19387', 'x-dsh-sessions': '1', ...headers },
      async *[Symbol.asyncIterator]() {
        if (data !== undefined) yield Buffer.from(JSON.stringify(data))
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
    const handler = handlers.get(path)
    if (handler === undefined) throw new Error(`未注册 ${path}`)
    await handler(req, res)
    return result
  }

  beforeEach(() => {
    vi.resetAllMocks()
    rejection = undefined
    handlers = new Map()
    transport = undefined
    operations.exportArchive.mockResolvedValue(Buffer.from('archive bytes'))
    operations.previewArchive.mockResolvedValue(preview)
    operations.importArchive.mockResolvedValue(imported)
    const context = {
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
      sessionQuery: {
        listSessions: async () => [
          { header: { id: 'example', cwd: '/source' }, live: true },
          { header: { id: 'child', origin: 'subagent' }, live: false },
        ],
        readTitleSnapshots: async () => [
          { sessionId: 'example', status: 'fulfilled', value: { title: { title: '示例标题' } } },
        ],
      },
      get: () => transport,
    } as never
    apply(context)
  })

  it('列出普通会话、导出、预览并确认导入', async () => {
    expect((await request(LIST_PATH)).body.sessions).toEqual([
      { id: 'example', cwd: '/source', live: true, title: '示例标题' },
    ])
    expect((await request(EXPORT_PATH, { id: 'example' })).body).toMatchObject({
      archive: payload.archive,
      filename: 'dsh-session-example.zip',
    })
    expect((await request(PREVIEW_PATH, payload)).body).toEqual(preview)
    expect((await request(IMPORT_PATH, payload)).body).toEqual(imported)
    expect(operations.importArchive).toHaveBeenCalledWith(
      expect.anything(),
      Buffer.from('archive bytes'),
      '/target',
      expected,
    )
  })

  it('所有读写接口都必须通过宿主认证', async () => {
    rejection = 401
    for (const path of [LIST_PATH, REMOTES_PATH]) expect((await request(path)).status).toBe(401)
    for (const path of [EXPORT_PATH, PREVIEW_PATH, IMPORT_PATH, TRANSFER_PATH])
      expect((await request(path, payload)).status).toBe(401)
    expect(operations.exportArchive).not.toHaveBeenCalled()
    expect(operations.importArchive).not.toHaveBeenCalled()
    rejection = 403
    expect((await request(PREVIEW_PATH, payload)).status).toBe(403)
  })

  it('拒绝跨站、错误协议标记和方法', async () => {
    expect((await request(PREVIEW_PATH, payload, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await request(PREVIEW_PATH, payload, { 'x-dsh-sessions': undefined })).status).toBe(403)
    expect((await request(LIST_PATH, {}, {}, 'POST')).status).toBe(403)
    expect(operations.previewArchive).not.toHaveBeenCalled()
  })

  it('缺少可信确认或预览版本时拒绝写入，Base64 不容忍静默损坏', async () => {
    expect((await request(IMPORT_PATH, { ...payload, trusted: false })).status).toBe(400)
    expect((await request(IMPORT_PATH, { ...payload, expected: undefined })).status).toBe(400)
    expect(
      (await request(IMPORT_PATH, { ...payload, expected: { ...expected, sessions: { example: 42 } } }))
        .status,
    ).toBe(400)
    expect((await request(PREVIEW_PATH, { ...payload, archive: '%%%not-base64' })).status).toBe(400)
    expect((await request(EXPORT_PATH, { id: '' })).status).toBe(400)
    expect(operations.importArchive).not.toHaveBeenCalled()
  })

  it('会话档案请求可显式超过其他插件默认的 2 MiB 限额', async () => {
    const archive = Buffer.alloc(2 * 1024 * 1024, 65).toString('base64')
    expect((await request(PREVIEW_PATH, { archive, cwd: '/target' })).status).toBe(200)
    expect(operations.previewArchive.mock.calls[0]?.[1].length).toBe(2 * 1024 * 1024)
  })

  it('并行导入明确冲突，失败后释放互斥状态并保留实际原因', async () => {
    let finish: (value: typeof imported) => void = () => {
      throw new Error('尚未建立等待')
    }
    operations.importArchive.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = request(IMPORT_PATH, payload)
    await vi.waitFor(() => expect(operations.importArchive).toHaveBeenCalledTimes(1))
    expect((await request(IMPORT_PATH, payload)).status).toBe(409)
    finish(imported)
    expect((await first).status).toBe(200)
    operations.importArchive.mockRejectedValueOnce(new Error('EACCES: 目标持久化目录不可写'))
    expect((await request(IMPORT_PATH, payload)).body.error).toBe('EACCES: 目标持久化目录不可写')
    expect((await request(IMPORT_PATH, payload)).status).toBe(200)
  })

  it('真实远端通道与会话接收路由贯通，认证、协议标记和确认字段均被接收', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/?token=launch-secret') {
        const name = `dsh-auth-${createHash('sha256').update(req.headers.host!).digest('base64url')}`
        res.writeHead(303, {
          location: './',
          'set-cookie': `${name}=session; Path=/; HttpOnly; SameSite=Strict`,
        })
        res.end()
        return
      }
      const handler = handlers.get(req.url ?? '')
      if (handler === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      void handler(req, res).catch((error: Error) => {
        res.writeHead(500)
        res.end(error.message)
      })
    })
    const context = new Context()
    try {
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('接收端没有监听 TCP')
      const row: ConnRow = {
        id: 'target',
        label: '目标机器',
        sshAlias: 'target',
        createdAt: '2027-01-01',
        updatedAt: '2027-01-01',
        state: {
          phase: 'running',
          op: null,
          error: null,
          lastSync: { skills: null, mcp: null, plugins: null, prompts: null },
          running: {
            url: `http://127.0.0.1:${address.port}/?token=launch-secret`,
            localPort: address.port,
            remotePort: 19387,
            pid: 42,
            since: '2027-01-01',
          },
        },
      }
      const engine = new RemoteEngine({} as EngineDeps)
      vi.spyOn(engine, 'rows').mockReturnValue([row])
      new RemoteTransportService(context, engine)
      expect(
        await context.remoteTransport.request('target', PREVIEW_PATH, {
          archive: payload.archive,
          cwd: payload.cwd,
        }),
      ).toEqual(preview)
      expect(await context.remoteTransport.request('target', IMPORT_PATH, payload)).toEqual(imported)
      expect(operations.importArchive).toHaveBeenCalledOnce()
      await expect(
        context.remoteTransport.request('target', IMPORT_PATH, { ...payload, trusted: false }),
      ).rejects.toThrow('确认档案来源可信')
      expect(operations.importArchive).toHaveBeenCalledOnce()
    } finally {
      await context.fiber.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('远端能力缺席不影响本地，远端请求只转发预览和导入', async () => {
    expect((await request(REMOTES_PATH)).body).toEqual({ available: false, connections: [] })
    expect(
      (await request(TRANSFER_PATH, { ...payload, remoteId: 'machine', action: 'preview' })).status,
    ).toBe(503)
    expect((await request(PREVIEW_PATH, payload)).status).toBe(200)
    transport = {
      listConnections: vi.fn(() => [{ id: 'machine', label: '目标机器', available: true }]),
      request: vi.fn(async (_id, path) => (path === PREVIEW_PATH ? preview : imported)),
    }
    expect((await request(REMOTES_PATH)).body.available).toBe(true)
    expect(
      (await request(TRANSFER_PATH, { ...payload, remoteId: 'machine', action: 'preview' })).body,
    ).toEqual(preview)
    expect(transport.request).toHaveBeenLastCalledWith('machine', PREVIEW_PATH, {
      archive: payload.archive,
      cwd: payload.cwd,
    })
    expect(
      (await request(TRANSFER_PATH, { ...payload, remoteId: 'machine', action: 'import' })).body,
    ).toEqual(imported)
    expect(transport.request).toHaveBeenLastCalledWith('machine', IMPORT_PATH, payload)
    expect((await request(TRANSFER_PATH, { ...payload, remoteId: 'machine', action: 'pull' })).status).toBe(
      400,
    )
  })
})
