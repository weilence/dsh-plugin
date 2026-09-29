import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { apply } from '../src/index'

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, body: {} }
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(payload?: Buffer) {
      try {
        captured.body = JSON.parse((payload ?? Buffer.alloc(0)).toString('utf8')) as Record<string, unknown>
      } catch {
        captured.body = {}
      }
    },
  } as unknown as ServerResponse
  return { res, done: Promise.resolve(captured) }
}

type Resolve = (name: string) => Promise<unknown>

async function setup(resolve: Resolve) {
  const logs: string[] = []
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const ctx = {
    effect: (register: () => unknown) => register(),
    webServer: {
      host: '127.0.0.1',
      register(options: {
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) {
        handlers.set(options.path, options.handler)
        return () => handlers.delete(options.path)
      },
    },
    credentials: { resolve },
    logger: {
      error: (message: string) => logs.push(message),
      info: (message: string) => logs.push(message),
    },
  }
  await apply(ctx as never)
  const request = async (method: string, host: string | undefined): Promise<CapturedResponse> => {
    const handler = handlers.get('/dsh-zhipu-tools/usage')
    if (handler === undefined) throw new Error('usage 路由未注册')
    const req = {
      headers: host === undefined ? {} : { host },
      method,
      url: '/dsh-zhipu-tools/usage',
    } as unknown as IncomingMessage
    const { res, done } = fakeRes()
    await handler(req, res)
    return done
  }
  return { logs, request }
}

describe('/dsh-zhipu-tools/usage 栅栏', () => {
  it('Host 匹配绑定地址（loopback 拼写等价）的 GET 放行', async () => {
    const { request } = await setup(async () => undefined)
    expect((await request('GET', '127.0.0.1:19387')).status).toBe(200)
    expect((await request('GET', 'localhost:3080')).status).toBe(200)
  })

  it('Host 不匹配、缺 Host 或方法非 GET 一律 403', async () => {
    const { request } = await setup(async () => undefined)
    expect(await request('GET', 'example.com:80')).toMatchObject({
      status: 403,
      body: { ok: false, error: 'forbidden' },
    })
    expect((await request('GET', undefined)).status).toBe(403)
    expect((await request('POST', '127.0.0.1:19387')).status).toBe(403)
  })
})

describe('凭证解析', () => {
  it('两个候选都缺席报「未配置」，用量桥透传该原因', async () => {
    const { logs, request } = await setup(async () => undefined)
    expect(logs.some((line) => line.includes('未配置 zai-coding-cn 供应商'))).toBe(true)
    const res = await request('GET', '127.0.0.1:19387')
    expect(res.body).toEqual({ ok: false, error: '未配置 zai-coding-cn 供应商' })
  })

  it('resolve 抛错按解析失败上报，错误携带真实原因而非「未配置」', async () => {
    const { logs, request } = await setup(async () => {
      throw new Error('凭证服务不可用')
    })
    expect(logs.some((line) => line.includes('凭证解析失败') && line.includes('凭证服务不可用'))).toBe(true)
    expect(logs.some((line) => line.includes('未配置'))).toBe(false)
    const res = await request('GET', '127.0.0.1:19387')
    expect(res.body.error).toContain('凭证服务不可用')
  })
})
