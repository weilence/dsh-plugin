// host 桥：假 ctx/webServer + 临时目录的路由集成往返——list（作用域根扫描
// 与同名遮蔽）、file（根内放行 / 越界 403）、save（新建 / 重名 409 / 校验
// 400）、delete（单文件与目录包 / 深路径拒绝）、守卫 403。Git 四路由由
// gitInstall / gitUpdate 的真实仓库单测承载，不在桥层重复。

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const chunks: Buffer[] = []
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(payload?: Buffer) {
      captured.body = payload === undefined ? {} : (JSON.parse(payload.toString()) as Record<string, unknown>)
    },
  } as unknown as ServerResponse
  const captured: CapturedResponse = { status: 0, body: {} }
  return { res, done: Promise.resolve(captured) }
}

const HEADERS = { host: '127.0.0.1:19387' }

function getReq(path: string, headers: Record<string, string> = HEADERS): IncomingMessage {
  return { headers, method: 'GET', url: path } as unknown as IncomingMessage
}

function postReq(body: unknown, headers: Record<string, string> = HEADERS): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    headers,
    method: 'POST',
    url: '/',
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  } as unknown as IncomingMessage
}

describe('dsh-skills 桥路由', () => {
  let home: string
  let handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>

  const request = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    headers: Record<string, string> = HEADERS,
  ): Promise<CapturedResponse> => {
    const handler = handlers.get(path.split('?')[0])
    if (handler === undefined) throw new Error(`no handler for ${path}`)
    const { res, done } = fakeRes()
    await handler(method === 'GET' ? getReq(path, headers) : postReq(body, headers), res)
    return done
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-skills-host-'))
    handlers = new Map()
    const ctx = {
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      webServer: {
        host: '127.0.0.1',
        register(route: {
          path: string
          handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
        }) {
          handlers.set(route.path, route.handler)
          return () => handlers.delete(route.path)
        },
      },
      get: () => undefined,
    }
    apply(ctx as never)
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  it('守卫：Host 不符 403，跨站 POST 403', async () => {
    expect(
      (await request('GET', '/dsh-skills/list?scope=workspace', undefined, { host: 'evil.example' })).status,
    ).toBe(403)
    expect(
      (
        await request(
          'POST',
          '/dsh-skills/save',
          {},
          { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' },
        )
      ).status,
    ).toBe(403)
  })

  it('GET /list：工作区档扫描 + 同名遮蔽 + 无效条目呈现', async () => {
    const dshRoot = join(home, '.dsh', 'skills')
    const agentsRoot = join(home, '.agents', 'skills')
    await mkdir(dshRoot, { recursive: true })
    await mkdir(join(agentsRoot, 'demo', 'sub'), { recursive: true })
    await writeFile(join(dshRoot, 'demo.md'), '---\nname: demo\ndescription: 根单文件版\n---\n正文\n', 'utf8')
    await writeFile(
      join(agentsRoot, 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: 目录包版\n---\n正文\n',
      'utf8',
    )
    await writeFile(join(dshRoot, 'broken.md'), '没有 frontmatter 的文件\n', 'utf8')

    const response = await request('GET', `/dsh-skills/list?scope=workspace&cwd=${encodeURIComponent(home)}`)
    expect(response.status).toBe(200)
    const rows = (response.body as { skills: Record<string, unknown>[] }).skills
    expect(rows.map((row) => row.name)).toEqual(['broken', 'demo', 'demo'])
    // 同名遮蔽：project-dsh（rank 低）胜出，project-agents 条目不生效
    const dshRow = rows.find((row) => row.rootId === 'project-dsh' && row.name === 'demo')
    const agentsRow = rows.find((row) => row.rootId === 'project-agents' && row.name === 'demo')
    expect(dshRow).toMatchObject({ effective: true, editable: true, format: 'flat' })
    expect(agentsRow).toMatchObject({ effective: false, format: 'bundle' })
    // 无效条目仍列出（带原因），不参与遮蔽判定
    expect(rows.find((row) => row.name === 'broken')).toMatchObject({
      invalid: expect.stringContaining('frontmatter'),
    })
    const roots = (response.body as { roots: { id: string; present: boolean }[] }).roots
    expect(roots.map((root) => root.id)).toEqual(['project-dsh', 'project-agents'])
    expect(roots.every((root) => root.present)).toBe(true)
  })

  it('GET /file：根内放行读原文，越界 403', async () => {
    const target = join(home, '.dsh', 'skills', 'a.md')
    await mkdir(join(home, '.dsh', 'skills'), { recursive: true })
    await writeFile(target, '---\nname: a\ndescription: d\n---\n正文\n', 'utf8')
    const ok = await request(
      'GET',
      `/dsh-skills/file?cwd=${encodeURIComponent(home)}&path=${encodeURIComponent(target)}`,
    )
    expect(ok.status).toBe(200)
    expect((ok.body as { raw: string }).raw).toContain('name: a')
    const outside = await request(
      'GET',
      `/dsh-skills/file?cwd=${encodeURIComponent(home)}&path=${encodeURIComponent(join(home, 'outside.md'))}`,
    )
    expect(outside.status).toBe(403)
  })

  it('POST /save：新建落盘 + 重名 409 + 校验 400', async () => {
    const create = await request('POST', '/dsh-skills/save', {
      cwd: home,
      rootId: 'project-dsh',
      name: 'beta',
      description: '描述',
      body: '正文',
    })
    expect(create.status).toBe(200)
    const target = (create.body as { path: string }).path
    expect(target).toBe(join(home, '.dsh', 'skills', 'beta.md'))
    const raw = await readFile(target, 'utf8')
    expect(raw).toContain('name: beta')
    expect(raw.endsWith('正文\n')).toBe(true)

    const duplicate = await request('POST', '/dsh-skills/save', {
      cwd: home,
      rootId: 'project-dsh',
      name: 'beta',
      description: '再来一次',
      body: 'x',
    })
    expect(duplicate.status).toBe(409)

    const badName = await request('POST', '/dsh-skills/save', {
      cwd: home,
      rootId: 'project-dsh',
      name: 'Bad_Name',
      description: 'd',
      body: 'x',
    })
    expect(badName.status).toBe(400)
    const noDescription = await request('POST', '/dsh-skills/save', {
      cwd: home,
      rootId: 'project-dsh',
      name: 'gamma',
      description: '  ',
      body: 'x',
    })
    expect(noDescription.status).toBe(400)
  })

  it('POST /delete：单文件删除，深路径 400，根外 403', async () => {
    const root = join(home, '.dsh', 'skills')
    const flat = join(root, 'flat.md')
    const deep = join(root, 'pkg', 'sub', 'x.md')
    await mkdir(join(root, 'pkg', 'sub'), { recursive: true })
    await writeFile(flat, '---\nname: flat\ndescription: d\n---\nx\n', 'utf8')
    await writeFile(deep, 'x', 'utf8')

    const removed = await request('POST', '/dsh-skills/delete', { cwd: home, path: flat })
    expect(removed.status).toBe(200)
    expect((removed.body as { removed: boolean }).removed).toBe(true)

    const tooDeep = await request('POST', '/dsh-skills/delete', { cwd: home, path: deep })
    expect(tooDeep.status).toBe(400)

    const outside = await request('POST', '/dsh-skills/delete', { cwd: home, path: join(home, 'outside.md') })
    expect(outside.status).toBe(403)
  })
})
