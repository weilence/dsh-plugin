import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { DELETE_PATH, FILE_PATH, SAVE_PATH, type PromptFile } from '../src/shared'

interface Response {
  status: number
  body: Record<string, unknown>
}

const headers = { host: '127.0.0.1:19387', 'x-dsh-prompts': '1' }

describe('全局提示词路由', () => {
  let home: string
  let previousHome: string | undefined
  let handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
  let context: Parameters<typeof apply>[0]

  async function request(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    data?: unknown,
    extra = {},
  ): Promise<Response> {
    const handler = handlers.get(path)
    if (handler === undefined) throw new Error(`未注册路由：${path}`)
    const response: Response = { status: 0, body: {} }
    const req = {
      method,
      headers: { ...headers, ...extra },
      async *[Symbol.asyncIterator]() {
        if (data !== undefined) yield Buffer.from(JSON.stringify(data))
      },
    } as unknown as IncomingMessage
    const res = {
      writeHead(status: number) {
        response.status = status
      },
      end(payload: Buffer) {
        response.body = JSON.parse(payload.toString()) as Record<string, unknown>
      },
    } as unknown as ServerResponse
    await handler(req, res)
    return response
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-prompts-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    handlers = new Map()
    context = {
      effect(fn: () => unknown) {
        fn()
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
    } as never
    apply(context)
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('读取不存在的文件，新建、编辑、删除形成完整往返', async () => {
    const empty = await request(FILE_PATH)
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({
      path: join(home, 'AGENTS.md'),
      exists: false,
      content: '',
      revision: null,
    })

    const created = await request(SAVE_PATH, 'POST', { content: '# 全局约定\n', revision: null })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ exists: true, content: '# 全局约定\n' })
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('# 全局约定\n')

    const saved = await request(SAVE_PATH, 'POST', { content: '第二版', revision: created.body.revision })
    expect(saved.status).toBe(200)
    expect(saved.body.revision).not.toBe(created.body.revision)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('第二版')

    const removed = await request(DELETE_PATH, 'POST', { revision: saved.body.revision })
    expect(removed).toMatchObject({ status: 200, body: { exists: false, revision: null } })
    expect((await request(FILE_PATH)).body.exists).toBe(false)
  })

  it('显式配置的 dshHome 优先于环境变量', async () => {
    const configured = join(home, 'custom-home')
    apply(context, { dshHome: configured })
    expect((await request(FILE_PATH)).body.path).toBe(join(configured, 'AGENTS.md'))
    expect((await request(SAVE_PATH, 'POST', { revision: null, content: '自定义目录' })).status).toBe(200)
    expect(await readFile(join(configured, 'AGENTS.md'), 'utf8')).toBe('自定义目录')
    expect((await request(FILE_PATH)).body.path).toBe(join(configured, 'AGENTS.md'))
  })

  it('禁止用旧版本覆盖外部更新、旧版本删除及重复创建', async () => {
    const created = (await request(SAVE_PATH, 'POST', { content: '初始内容', revision: null }))
      .body as unknown as PromptFile
    await writeFile(join(home, 'AGENTS.md'), '外部更新', 'utf8')
    expect((await request(SAVE_PATH, 'POST', { content: '覆盖', revision: created.revision })).status).toBe(
      409,
    )
    expect((await request(DELETE_PATH, 'POST', { revision: created.revision })).status).toBe(409)
    expect((await request(SAVE_PATH, 'POST', { content: '覆盖', revision: null })).status).toBe(409)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('外部更新')
  })

  it('拒绝符号链接及读取失败时的误覆盖', async () => {
    const outside = join(home, 'other.md')
    await writeFile(outside, '外部内容', 'utf8')
    await symlink(outside, join(home, 'AGENTS.md'))
    expect((await request(FILE_PATH)).status).toBe(400)
    expect((await request(SAVE_PATH, 'POST', { revision: null, content: '意外覆盖' })).status).toBe(400)
    expect(await readFile(outside, 'utf8')).toBe('外部内容')
  })

  it('拒绝跨站请求、无自定义头的写请求和畸形请求体', async () => {
    expect((await request(FILE_PATH, 'GET', undefined, { host: 'evil.example' })).status).toBe(403)
    expect(
      (await request(SAVE_PATH, 'POST', { content: 'x', revision: null }, { 'sec-fetch-site': 'cross-site' }))
        .status,
    ).toBe(403)
    expect(
      (await request(SAVE_PATH, 'POST', { content: 'x', revision: null }, { 'x-dsh-prompts': undefined }))
        .status,
    ).toBe(403)
    expect((await request(SAVE_PATH, 'POST', { content: 'x' })).status).toBe(400)
    expect((await request(SAVE_PATH, 'POST', { content: 123, revision: null })).status).toBe(400)
  })
})
