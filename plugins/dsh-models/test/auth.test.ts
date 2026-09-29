// 订阅登录桥：AuthAttemptRelay 的中继语义（事件序 / 应答 / 拒绝 / 撤回 /
// 收口）+ 假 ctx/webServer 的桥路由集成往返（目录过滤 scope、begin 预检、
// 事件流与应答、取消、守卫 403）。

import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow, AuthorizationInteraction } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { AuthAttemptRelay, applyAuthBridge } from '../src/auth'

describe('AuthAttemptRelay 中继', () => {
  it('notify 与 prompt 按单调 seq 入缓冲，eventsAfter 只回补新增', () => {
    const relay = new AuthAttemptRelay()
    relay.notify({ message: '打开授权页', url: 'https://auth.example' })
    const prompt = relay.prompt({ kind: 'text', message: '粘贴授权码' })
    const first = relay.eventsAfter(0)
    expect(first.events.map((event) => event.seq)).toEqual([1, 2])
    expect(first.events[0]).toMatchObject({
      kind: 'notice',
      message: '打开授权页',
      url: 'https://auth.example',
    })
    expect(first.events[1]).toMatchObject({
      kind: 'prompt',
      promptId: 2,
      prompt: { kind: 'text', message: '粘贴授权码' },
    })
    expect(relay.eventsAfter(2).events).toHaveLength(0)
    relay.answer('code-1')
    void prompt.catch(() => {})
    expect(relay.eventsAfter(2).events.map((event) => event.kind)).toEqual(['answered'])
  })

  it('answer 兑现挂起问题；decline 以官方 Declined 错误拒绝', async () => {
    const relay = new AuthAttemptRelay()
    const prompt = relay.prompt({ kind: 'secret', message: '输入密钥' })
    expect(relay.answer('secret-value')).toBe(true)
    await expect(prompt).resolves.toBe('secret-value')
    expect(relay.answer('again')).toBe(false)

    const second = relay.prompt({ kind: 'text', message: '再问一次' })
    expect(relay.decline()).toBe(true)
    await expect(second).rejects.toBeInstanceOf(AuthorizationDeclinedError)
  })

  it('空字符串是合法应答（copilot 的「Enterprise URL 空 = github.com」依赖它）', async () => {
    const relay = new AuthAttemptRelay()
    const prompt = relay.prompt({
      kind: 'text',
      message: 'GitHub Enterprise URL/domain (blank for github.com)',
    })
    expect(relay.answer('')).toBe(true)
    await expect(prompt).resolves.toBe('')
  })

  it('prompt 自带 signal 撤回：非 Declined 拒绝 + withdrawn 事件', async () => {
    const relay = new AuthAttemptRelay()
    const controller = new AbortController()
    const prompt = relay.prompt({ kind: 'text', message: '浏览器回调赛跑', signal: controller.signal })
    controller.abort()
    await expect(prompt).rejects.toThrow('登录问题已被流程撤回')
    expect(relay.eventsAfter(0).events.map((event) => event.kind)).toEqual(['prompt', 'withdrawn'])
    // 撤回后没有挂起问题，answer 显式失败。
    expect(relay.answer('late')).toBe(false)
  })

  it('settle 收口：清挂起问题、写 outcome，running 翻 false', async () => {
    const relay = new AuthAttemptRelay()
    const prompt = relay.prompt({ kind: 'text', message: '还没答完' })
    relay.settle('failed', '流程崩溃')
    await expect(prompt).rejects.toThrow('登录已结束')
    const { events, running } = relay.eventsAfter(0)
    expect(events.at(-1)).toMatchObject({ kind: 'outcome', status: 'failed', error: '流程崩溃' })
    expect(running).toBe(false)
    // 重复 settle 不产生第二条 outcome。
    relay.settle('authorized')
    expect(relay.eventsAfter(0).events.filter((event) => event.kind === 'outcome')).toHaveLength(1)
  })
})

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
      captured.body = payload === undefined ? {} : (JSON.parse(payload.toString()) as Record<string, unknown>)
    },
  } as unknown as ServerResponse
  return { res, done: Promise.resolve(captured) }
}

const HEADERS: Record<string, string> = { host: '127.0.0.1:19387' }

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

/** 受控的 authorization 服务：脚本化 flow 让集成往返可断言。 */
function authorizationStub(
  script: {
    run?: (interaction: AuthorizationInteraction) => Promise<void>
  } = {},
) {
  const flows = new Map<string, AuthorizationFlow>()
  const begin = vi.fn(
    async (request: { key: { toString(): string }; interaction: AuthorizationInteraction }) => {
      const flow = flows.get(request.key.toString())
      if (flow === undefined)
        throw Object.assign(new Error(`no authorization flow is registered for "${request.key}"`), {
          code: 'NO_FLOW',
        })
      await script.run?.(request.interaction)
      return { status: 'authorized' as const }
    },
  )
  const service = {
    registerFlow: (flow: AuthorizationFlow) => {
      flows.set(flow.key.toString(), flow)
      return () => flows.delete(flow.key.toString())
    },
    list: () =>
      [...flows.values()].map((flow) => ({
        key: flow.key,
        label: flow.label,
        methods: flow.methods,
        inFlight: false,
      })),
    describe: (key: { toString(): string }) => {
      const flow = flows.get(key.toString())
      return flow === undefined
        ? undefined
        : { key: flow.key, label: flow.label, methods: flow.methods, inFlight: false }
    },
    begin,
    cancel: vi.fn(),
  }
  return { service, begin }
}

function bridgeHost(script?: Parameters<typeof authorizationStub>[0]) {
  const handlers = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void> | void>()
  const authorization = authorizationStub(script)
  // 复刻宿主装配：llm-pi-ai 为带登录的目录 provider 注册 flow——oauth 型
  // （openai-codex）、api-key 交互型（openai）、双形态（openrouter）。
  authorization.service.registerFlow({
    key: credentialKey('llm-pi-ai', 'openai-codex'),
    label: 'OpenAI Codex',
    methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
    run: async () => {},
  })
  authorization.service.registerFlow({
    key: credentialKey('llm-pi-ai', 'openai'),
    label: 'OpenAI',
    methods: [{ id: 'api-key', label: 'OpenAI API key' }],
    run: async () => {},
  })
  authorization.service.registerFlow({
    key: credentialKey('llm-pi-ai', 'openrouter'),
    label: 'OpenRouter',
    methods: [
      { id: 'oauth', label: 'Sign in with OpenRouter' },
      { id: 'api-key', label: 'OpenRouter API key' },
    ],
    run: async () => {},
  })
  authorization.service.registerFlow({
    key: credentialKey('other-plugin', 'gateway'),
    label: '别的插件的 flow',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    run: async () => {},
  })
  const describeRecord = vi.fn(async () => ({ configured: true, kind: 'grant' as const, writable: true }))
  const ctx = {
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
    authorization: authorization.service,
    get: (name: string) => (name === 'credentials' ? { describeRecord } : undefined),
  }
  const dispose = applyAuthBridge(ctx as never)
  const request = async (method: 'GET' | 'POST', path: string, body?: unknown, headers = HEADERS) => {
    const handler = handlers.get(path.split('?')[0])
    if (handler === undefined) throw new Error(`no handler for ${path}`)
    const { res, done } = fakeRes()
    await handler(method === 'GET' ? getReq(path, headers) : postReq(body, headers), res)
    return done
  }
  return { request, dispose, authorization, describeRecord }
}

describe('订阅登录桥', () => {
  it('GET 目录：只收 llm-pi-ai scope 且带 oauth 方法的 flow（api-key 交互型不进）', async () => {
    const host = bridgeHost()
    const response = await host.request('GET', '/dsh-models/auth')
    expect(response.status).toBe(200)
    expect(response.body['flows']).toEqual({
      'openai-codex': {
        label: 'OpenAI Codex',
        methods: [{ id: 'oauth', label: 'OpenAI (ChatGPT Plus/Pro)' }],
      },
      openrouter: {
        label: 'OpenRouter',
        methods: [
          { id: 'oauth', label: 'Sign in with OpenRouter' },
          { id: 'api-key', label: 'OpenRouter API key' },
        ],
      },
    })
    // openai（api-key 交互型登录）不进 flows，也就没有 records 项。
    expect(response.body['records']).toEqual({
      'openai-codex': { configured: true, kind: 'grant' },
      openrouter: { configured: true, kind: 'grant' },
    })
    expect(response.body['attempt']).toBeNull()
    host.dispose()
  })

  it('begin 预检：无 flow / 键不可寻址 404，进行中 409，守卫 403', async () => {
    const host = bridgeHost()
    expect(
      (await host.request('POST', '/dsh-models/auth/begin', { provider: 'unknown-gateway' })).status,
    ).toBe(404)
    expect((await host.request('POST', '/dsh-models/auth/begin', { provider: 'My.Gateway' })).status).toBe(
      404,
    )
    expect((await host.request('POST', '/dsh-models/auth/begin', {})).status).toBe(400)
    expect(
      (
        await host.request(
          'POST',
          '/dsh-models/auth/begin',
          { provider: 'openai-codex' },
          {
            ...HEADERS,
            'sec-fetch-site': 'cross-site',
          },
        )
      ).status,
    ).toBe(403)
    expect((await host.request('GET', '/dsh-models/auth', undefined, { host: 'evil.example' })).status).toBe(
      403,
    )
    host.dispose()
  })

  it('begin → 事件流 → 应答 → outcome 的完整往返，attempt 进目录', async () => {
    // flow 脚本：抛通知、问一个选择题，拿到应答后结束。
    let asked: ((value: string) => void) | undefined
    const host = bridgeHost({
      run: async (interaction) => {
        interaction.notify({ message: '继续登录', url: 'https://auth.example/device', code: 'ABCD-1234' })
        const answer = await interaction.prompt({
          kind: 'select',
          message: '选择登录方式',
          options: [
            { id: 'browser', label: '浏览器登录' },
            { id: 'device_code', label: '设备码登录' },
          ],
        })
        asked?.(answer)
      },
    })
    const begin = await host.request('POST', '/dsh-models/auth/begin', { provider: 'openai-codex' })
    expect(begin.status).toBe(200)
    // begin 是即答的：attempt 仍在进行。
    const directory = await host.request('GET', '/dsh-models/auth')
    expect(directory.body['attempt']).toEqual({ provider: 'openai-codex' })
    const events = await host.request('GET', '/dsh-models/auth/events?after=0')
    expect(events.body['running']).toBe(true)
    const list = events.body['events'] as Record<string, unknown>[]
    expect(list.map((event) => event['kind'])).toEqual(['notice', 'prompt'])
    expect(list[0]).toMatchObject({ url: 'https://auth.example/device', code: 'ABCD-1234' })
    expect(list[1]).toMatchObject({
      prompt: { kind: 'select', options: [{ id: 'browser' }, { id: 'device_code' }] },
    })

    const answered = new Promise<string>((resolve) => (asked = resolve))
    expect((await host.request('POST', '/dsh-models/auth/answer', { value: 'browser' })).status).toBe(200)
    expect(await answered).toBe('browser')
    expect((await host.request('POST', '/dsh-models/auth/answer', { value: 'late' })).status).toBe(409)
    expect((await host.request('POST', '/dsh-models/auth/answer', {})).status).toBe(400)

    // 脚本 flow 结束（begin 兑现 authorized）后 outcome 入流，running 翻 false。
    const settled = await host.request('GET', '/dsh-models/auth/events?after=2')
    expect(settled.body['running']).toBe(false)
    expect((settled.body['events'] as Record<string, unknown>[]).at(-1)).toMatchObject({
      kind: 'outcome',
      status: 'authorized',
    })
    expect((await host.request('GET', '/dsh-models/auth')).body['attempt']).toBeNull()
    host.dispose()
  })

  it('decline 走官方 Declined 语义：flow 收到拒绝后自行收场', async () => {
    let failure: unknown
    const host = bridgeHost({
      run: async (interaction) => {
        try {
          await interaction.prompt({ kind: 'text', message: '粘贴授权码' })
        } catch (error) {
          failure = error
          throw error
        }
      },
    })
    await host.request('POST', '/dsh-models/auth/begin', { provider: 'openai-codex' })
    await host.request('GET', '/dsh-models/auth/events?after=0')
    expect((await host.request('POST', '/dsh-models/auth/answer', { declined: true })).status).toBe(200)
    await vi.waitFor(() => expect(failure).toBeInstanceOf(AuthorizationDeclinedError))
    const settled = await host.request('GET', '/dsh-models/auth/events?after=1')
    expect((settled.body['events'] as Record<string, unknown>[]).at(-1)).toMatchObject({
      kind: 'outcome',
      status: 'failed',
    })
    host.dispose()
  })

  it('cancel 撤回进行中的尝试，dispose 一并撤回', async () => {
    const host = bridgeHost({
      run: () => new Promise(() => {}),
    })
    await host.request('POST', '/dsh-models/auth/begin', { provider: 'openai-codex' })
    expect((await host.request('POST', '/dsh-models/auth/cancel', {})).status).toBe(200)
    expect(host.authorization.service.cancel).toHaveBeenCalledWith(credentialKey('llm-pi-ai', 'openai-codex'))
    host.dispose()

    const pending = bridgeHost({ run: () => new Promise(() => {}) })
    await pending.request('POST', '/dsh-models/auth/begin', { provider: 'openai-codex' })
    pending.dispose()
    expect(pending.authorization.service.cancel).toHaveBeenCalledWith(
      credentialKey('llm-pi-ai', 'openai-codex'),
    )
  })
})
