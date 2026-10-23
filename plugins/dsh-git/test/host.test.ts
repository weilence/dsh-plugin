import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index'
import {
  FILES_PATH,
  LOG_PATH,
  REPOS_PATH,
  type GitCommitFiles,
  type GitLog,
  type GitRepoScan,
} from '../src/shared'

const log = vi.hoisted(() => ({ readGitLog: vi.fn(), readCommitFiles: vi.fn() }))
vi.mock('../src/log', () => log)

describe('Git 插件宿主路由', () => {
  let rejection: 401 | 403 | undefined
  let handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
  let root: string

  async function request(
    data: unknown = { cwd: root },
    headers: Record<string, string | undefined> = {},
    method = 'POST',
    path: string = REPOS_PATH,
  ) {
    const result: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
    const req = {
      method,
      headers: { host: '127.0.0.1:19387', 'x-dsh-git': '1', ...headers },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(data))
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

  beforeEach(async () => {
    vi.resetAllMocks()
    rejection = undefined
    handlers = new Map()
    root = await mkdtemp(join(tmpdir(), 'dsh-git-host-'))
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

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('注册扫描、提交图与文件变更三条路由', () => {
    expect([...handlers.keys()]).toEqual([REPOS_PATH, LOG_PATH, FILES_PATH])
  })

  it('扫描路由返回目录下仓库', async () => {
    await mkdir(join(root, 'repo', '.git'), { recursive: true })
    await writeFile(join(root, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n')
    const { status, body } = await request()
    expect(status).toBe(200)
    const scan = body as unknown as GitRepoScan
    expect(scan.root).toBe(root)
    expect(scan.repos).toEqual([
      {
        root: join(root, 'repo'),
        name: 'repo',
        relPath: 'repo',
        kind: 'standard',
        branch: 'main',
      },
    ])
    expect(scan.truncated).toBe(false)
  })

  it('提交图路由校验目录与 limit 后透传读取', async () => {
    const done: GitLog = { commits: [], truncated: false }
    log.readGitLog.mockResolvedValue(done)
    const { status, body } = await request({ repo: root, limit: 30 }, {}, 'POST', LOG_PATH)
    expect(status).toBe(200)
    expect(body).toEqual(done)
    expect(log.readGitLog).toHaveBeenCalledWith(root, 30)

    expect((await request({ repo: root }, {}, 'POST', LOG_PATH)).status).toBe(200)
    expect(log.readGitLog).toHaveBeenLastCalledWith(root, 500)
    expect((await request({ repo: root, limit: 0 }, {}, 'POST', LOG_PATH)).status).toBe(400)
    expect((await request({ repo: root, limit: 'x' }, {}, 'POST', LOG_PATH)).status).toBe(400)
    expect((await request({ repo: join(root, 'missing') }, {}, 'POST', LOG_PATH)).status).toBe(400)
    log.readGitLog.mockRejectedValue(new Error('git 不可用：PATH 中未找到 git 可执行文件'))
    const failed = await request({ repo: root }, {}, 'POST', LOG_PATH)
    expect(failed.status).toBe(500)
    expect(failed.body).toEqual({ error: 'git 不可用：PATH 中未找到 git 可执行文件' })
  })

  it('文件变更路由校验目录与 hash 后透传读取', async () => {
    const done: GitCommitFiles = {
      hash: 'a1b2c3d',
      files: [{ path: 'src/a.ts', status: 'modified', added: 2, deleted: 1 }],
    }
    log.readCommitFiles.mockResolvedValue(done)
    const { status, body } = await request({ repo: root, hash: 'a1b2c3d' }, {}, 'POST', FILES_PATH)
    expect(status).toBe(200)
    expect(body).toEqual(done)
    expect(log.readCommitFiles).toHaveBeenCalledWith(root, 'a1b2c3d')

    expect((await request({ repo: root }, {}, 'POST', FILES_PATH)).status).toBe(400)
    expect((await request({ repo: root, hash: 'zz' }, {}, 'POST', FILES_PATH)).status).toBe(400)
    expect((await request({ repo: root, hash: 42 }, {}, 'POST', FILES_PATH)).status).toBe(400)
    expect(
      (await request({ repo: join(root, 'missing'), hash: 'a1b2c3d' }, {}, 'POST', FILES_PATH)).status,
    ).toBe(400)
  })

  it.each([401, 403] as const)('必须通过宿主认证（%s）', async (status) => {
    rejection = status
    expect(await request()).toEqual({
      status,
      body: { error: status === 401 ? 'Git 插件请求未通过宿主认证' : '请求来源不允许' },
    })
  })

  it('拒绝跨站、错误协议标记和方法', async () => {
    expect((await request({ cwd: root }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await request({ cwd: root }, { 'x-dsh-git': undefined })).status).toBe(403)
    expect((await request({ cwd: root }, { 'x-dsh-git': '0' })).status).toBe(403)
    expect((await request({ cwd: root }, {}, 'GET')).status).toBe(403)
  })

  it('缺少 cwd、目录不存在或不是目录时返回 400', async () => {
    expect((await request({})).status).toBe(400)
    expect((await request({ cwd: join(root, 'missing') })).status).toBe(400)
    await writeFile(join(root, 'file.txt'), 'x')
    expect((await request({ cwd: join(root, 'file.txt') })).status).toBe(400)
  })

  it('无效 JSON 请求体返回 400', async () => {
    const result: { status: number; body: Record<string, unknown> } = { status: 0, body: {} }
    const req = {
      method: 'POST',
      headers: { host: '127.0.0.1:19387', 'x-dsh-git': '1' },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('not json')
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
    await handlers.get(REPOS_PATH)!(req, res)
    expect(result.status).toBe(400)
  })
})
