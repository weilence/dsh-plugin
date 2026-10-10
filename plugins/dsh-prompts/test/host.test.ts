import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptSection } from '@deepseek-ai/dsh-system-prompt'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index'
import { FILE_PATH, SAVE_PATH, type PromptFile } from '../src/shared'

interface Response {
  status: number
  body: Record<string, unknown>
}

const headers = { host: '127.0.0.1:19387', 'x-dsh-prompts': '1' }
const FILE_NAME = 'system-prompt.md'

describe('系统提示词路由', () => {
  let home: string
  let previousHome: string | undefined
  let handlers: Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>
  let registered: PromptSection | undefined
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
      systemPrompt: {
        section(input: PromptSection) {
          registered = input
          return () => {}
        },
      },
      logger: { warn: () => {} },
    } as never
    apply(context)
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it('读取不存在的文件，新建与编辑形成完整往返', async () => {
    const empty = await request(FILE_PATH)
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({
      path: join(home, FILE_NAME),
      exists: false,
      content: '',
      revision: null,
    })

    const created = await request(SAVE_PATH, 'POST', { content: '# 全局约定\n', revision: null })
    expect(created.status).toBe(200)
    expect(created.body).toMatchObject({ exists: true, content: '# 全局约定\n' })
    expect(await readFile(join(home, FILE_NAME), 'utf8')).toBe('# 全局约定\n')

    const saved = await request(SAVE_PATH, 'POST', { content: '第二版', revision: created.body.revision })
    expect(saved.status).toBe(200)
    expect(saved.body.revision).not.toBe(created.body.revision)
    expect(await readFile(join(home, FILE_NAME), 'utf8')).toBe('第二版')
  })

  it('显式配置的 dshHome 优先于环境变量', async () => {
    const configured = join(home, 'custom-home')
    apply(context, { dshHome: configured })
    expect((await request(FILE_PATH)).body.path).toBe(join(configured, FILE_NAME))
    expect((await request(SAVE_PATH, 'POST', { revision: null, content: '自定义目录' })).status).toBe(200)
    expect(await readFile(join(configured, FILE_NAME), 'utf8')).toBe('自定义目录')
    expect((await request(FILE_PATH)).body.path).toBe(join(configured, FILE_NAME))
  })

  it('禁止用旧版本覆盖外部更新及重复创建', async () => {
    const created = (await request(SAVE_PATH, 'POST', { content: '初始内容', revision: null }))
      .body as unknown as PromptFile
    await writeFile(join(home, FILE_NAME), '外部更新', 'utf8')
    expect((await request(SAVE_PATH, 'POST', { content: '覆盖', revision: created.revision })).status).toBe(
      409,
    )
    expect((await request(SAVE_PATH, 'POST', { content: '覆盖', revision: null })).status).toBe(409)
    expect(await readFile(join(home, FILE_NAME), 'utf8')).toBe('外部更新')
  })

  it('拒绝符号链接及读取失败时的误覆盖', async () => {
    const outside = join(home, 'other.md')
    await writeFile(outside, '外部内容', 'utf8')
    await symlink(outside, join(home, FILE_NAME))
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

describe('系统提示词段', () => {
  let home: string
  let previousHome: string | undefined
  let registered: PromptSection | undefined

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-prompts-section-'))
    previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    registered = undefined
    const context = {
      effect(fn: () => unknown) {
        fn()
      },
      webServer: {
        host: '127.0.0.1',
        register() {
          return () => {}
        },
      },
      systemPrompt: {
        section(input: PromptSection) {
          registered = input
          return () => {}
        },
      },
      logger: { warn: () => {} },
    } as never
    apply(context)
  })

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  })

  const text = (): string => {
    if (typeof registered?.text !== 'function') throw new Error('段文本未注册为函数')
    return registered.text({})
  }

  it('注册用户段：固定名称、位于第一方末尾之后、不做变量插值', () => {
    expect(registered).toMatchObject({
      name: 'user:system-prompt',
      order: 10500,
      interpolate: false,
    })
  })

  it('段文本随文件即时同步，文件缺失时为空串', async () => {
    expect(text()).toBe('')
    await writeFile(join(home, FILE_NAME), '第一版\n', 'utf8')
    expect(text()).toBe('第一版\n')
    await writeFile(join(home, FILE_NAME), '第二版\n', 'utf8')
    expect(text()).toBe('第二版\n')
  })

  it('符号链接与超过 1 MiB 的文件不进入系统提示词', async () => {
    const outside = join(home, 'target.md')
    await writeFile(outside, '外部内容', 'utf8')
    await symlink(outside, join(home, FILE_NAME))
    expect(text()).toBe('')

    await rm(join(home, FILE_NAME))
    await writeFile(join(home, FILE_NAME), `${'x'.repeat(1024 * 1024)}x`, 'utf8')
    expect(text()).toBe('')
  })
})
