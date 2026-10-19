/** 面板路由与 provider 注册：假 ctx/webServer/web/configEditor 的集成往返。 */

import { describe, expect, it } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { APPLY_WEB_CONFIG_PATH, STATUS_PATH, type StatusView } from '../src/shared'
import { apply } from '../src/index'

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

function fakeReq(
  path: string,
  method: string,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage {
  return {
    url: path,
    method,
    headers: { host: '127.0.0.1', ...headers },
  } as unknown as IncomingMessage
}

function fakeRes(): { res: ServerResponse; done: Promise<CapturedResponse> } {
  const captured: CapturedResponse = { status: 0, body: {} }
  const chunks: Buffer[] = []
  let resolveDone: (capture: CapturedResponse) => void
  const done = new Promise<CapturedResponse>((resolve) => {
    resolveDone = resolve
  })
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    write(chunk: Buffer) {
      chunks.push(Buffer.from(chunk))
    },
    end(payload?: Buffer) {
      if (payload !== undefined) chunks.push(Buffer.from(payload))
      try {
        captured.body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        captured.body = {}
      }
      resolveDone!(captured)
    },
  }
  return { res: res as unknown as ServerResponse, done }
}

/** configEditor 眼里的一条可寻址插件行。 */
interface EntrySpec {
  id: string
  /** profile 覆盖层当前 config（缺省 = 无覆盖行）。 */
  current?: Record<string, unknown>
  /** 下层组合值（base bundle 等 fold 的结果）。 */
  inherited?: Record<string, unknown>
}

/** 一次 edit 调用的记录：change 的两个入参与返回值。 */
interface EditCall {
  id: string
  current: Record<string, unknown>
  inherited: Record<string, unknown>
  next: Record<string, unknown>
}

const desktopRows = (): EntrySpec[] => [
  {
    id: 'web',
    current: { searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' },
    inherited: { searchProvider: 'deepseek-official', fetchProvider: 'http' },
  },
  {
    id: 'web-deepseek-api',
    current: { apiKeyEnv: 'ZAI_CODING_CN_API_KEY', baseURL: 'http://127.0.0.1:39617' },
    inherited: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
  },
]

async function makeHarness(
  resolve: (name: string) => Promise<unknown>,
  options: { entries?: EntrySpec[]; editError?: (id: string) => Error | undefined } = {},
): Promise<{
  request(path: string, method?: string, headers?: Record<string, string>): Promise<CapturedResponse>
  errors: string[]
  edits: EditCall[]
  searchProviders: string[]
  fetchProviders: string[]
  dispose: () => Promise<void>
}> {
  const registrations = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const disposers: Array<() => unknown> = []
  const errors: string[] = []
  const edits: EditCall[] = []
  const searchProviders: string[] = []
  const fetchProviders: string[] = []
  const rows = new Map((options.entries ?? desktopRows()).map((row) => [row.id, { ...row }]))

  const configEditor = {
    entries: () => [...rows.keys()].map((id) => ({ options: { id, name: `@deepseek-ai/dsh-${id}` } })),
    edit: async (
      entry: { options: { id: string } },
      change: (
        current: Record<string, unknown>,
        inherited: Record<string, unknown>,
      ) => Record<string, unknown>,
    ) => {
      const failure = options.editError?.(entry.options.id)
      if (failure) throw failure
      const row = rows.get(entry.options.id)
      const current = structuredClone(row?.current ?? {})
      const inherited = structuredClone(row?.inherited ?? {})
      const next = change(current, inherited)
      rows.set(entry.options.id, { id: entry.options.id, current: next, inherited: row?.inherited ?? {} })
      edits.push({ id: entry.options.id, current, inherited, next })
    },
  }

  const ctx = {
    credentials: { resolve },
    effect: (register: () => unknown) => {
      const dispose = register() as () => unknown
      disposers.push(dispose)
      return dispose
    },
    web: {
      registerSearchProvider(provider: { id: string }) {
        searchProviders.push(provider.id)
        return () => {
          const index = searchProviders.indexOf(provider.id)
          if (index >= 0) searchProviders.splice(index, 1)
        }
      },
      registerFetchProvider(provider: { id: string }) {
        fetchProviders.push(provider.id)
        return () => {
          const index = fetchProviders.indexOf(provider.id)
          if (index >= 0) fetchProviders.splice(index, 1)
        }
      },
    },
    configEditor,
    webServer: {
      host: '127.0.0.1',
      register(route: {
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) {
        registrations.set(route.path, route.handler)
        return () => registrations.delete(route.path)
      },
    },
    logger: {
      error: (message: string) => errors.push(message),
      info: () => {},
    },
  }
  await apply(ctx as never)

  return {
    request: async (path, method = 'GET', headers = {}) => {
      const handler = registrations.get(path)
      if (handler === undefined) throw new Error(`路由未注册：${path}`)
      const { res, done } = fakeRes()
      await handler(fakeReq(path, method, headers), res)
      return done
    },
    errors,
    edits,
    searchProviders,
    fetchProviders,
    dispose: async () => {
      for (const dispose of disposers) await dispose()
    },
  }
}

const resolveWithKey = async (name: string): Promise<unknown> =>
  name === 'ZAI_CODING_CN_API_KEY' ? { value: 'k' } : undefined

describe('provider 注册', () => {
  it('apply 后两个 provider 在册，dispose 后全部注销', async () => {
    const harness = await makeHarness(resolveWithKey)
    expect(harness.searchProviders).toEqual(['zhipu-search-api'])
    expect(harness.fetchProviders).toEqual(['zhipu-fetch-api'])
    await harness.dispose()
    expect(harness.searchProviders).toHaveLength(0)
    expect(harness.fetchProviders).toHaveLength(0)
  })

  it('凭据缺席：启动即明确报错，provider 照常注册', async () => {
    const harness = await makeHarness(async () => undefined)
    expect(harness.errors[0]).toContain('未配置')
    expect(harness.searchProviders).toHaveLength(1)
  })
})

describe('状态路由', () => {
  it('凭据在场：返回已配置', async () => {
    const harness = await makeHarness(resolveWithKey)
    const capture = await harness.request(STATUS_PATH)
    expect(capture.status).toBe(200)
    expect(capture.body).toEqual({ credential: { configured: true } })
  })

  it('凭据缺席与解析故障：面板给缺失事实，故障原文透传', async () => {
    const missing = await makeHarness(async () => undefined)
    const missingView = (await missing.request(STATUS_PATH)).body as unknown as StatusView
    expect(missingView.credential).toEqual({ configured: false })

    const broken = await makeHarness(async () => {
      throw new Error('存储被锁')
    })
    const brokenView = (await broken.request(STATUS_PATH)).body as unknown as StatusView
    expect(brokenView.credential).toEqual({ configured: false, failure: expect.stringContaining('存储被锁') })
  })

  it('仅接受同源 GET：POST 或跨站标记拒 403', async () => {
    const harness = await makeHarness(async () => undefined)
    expect((await harness.request(STATUS_PATH, 'POST')).status).toBe(403)
    const capture = await harness.request(STATUS_PATH, 'GET', { 'sec-fetch-site': 'cross-site' })
    expect(capture.status).toBe(403)
  })
})

describe('写入路由 apply-web-config', () => {
  it('成功：先清 web-deepseek-api 覆盖行（next=inherited 即官方清除语义），再写 web 行点名两个 provider', async () => {
    const harness = await makeHarness(resolveWithKey)
    const capture = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST')
    expect(capture.status).toBe(200)
    expect(capture.body).toEqual({ ok: true })
    expect(harness.edits).toHaveLength(2)

    const [legacy, web] = harness.edits
    expect(legacy?.id).toBe('web-deepseek-api')
    expect(legacy?.next).toEqual(legacy?.inherited)
    expect(legacy?.next).not.toEqual(legacy?.current)

    expect(web?.id).toBe('web')
    expect(web?.next).toEqual({
      searchProvider: 'zhipu-search-api',
      fetchProvider: 'zhipu-fetch-api',
    })
  })

  it('web 行缺失：明确 409，不做任何写入', async () => {
    const harness = await makeHarness(resolveWithKey, {
      entries: desktopRows().filter((row) => row.id !== 'web'),
    })
    const capture = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST')
    expect(capture.status).toBe(409)
    expect(JSON.stringify(capture.body)).toContain('不可寻址')
    expect(harness.edits).toHaveLength(0)
  })

  it('旧版 web-deepseek-api 行已不存在：只写 web 行，无异常', async () => {
    const harness = await makeHarness(resolveWithKey, {
      entries: desktopRows().filter((row) => row.id !== 'web-deepseek-api'),
    })
    const capture = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST')
    expect(capture.status).toBe(200)
    expect(harness.edits.map((edit) => edit.id)).toEqual(['web'])
  })

  it('configEditor 拒绝（home 层覆盖等）：原文透传，web 行不被触碰', async () => {
    const harness = await makeHarness(resolveWithKey, {
      editError: (id) =>
        id === 'web-deepseek-api'
          ? new Error(
              'Configuration for "web-deepseek-api" is overridden by a home patch or command-line overlay',
            )
          : undefined,
    })
    const capture = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST')
    expect(capture.status).toBe(500)
    expect(JSON.stringify(capture.body)).toContain('overridden by a home patch')
    // 被拒的 edit 不留记录：web 行从未被触碰。
    expect(harness.edits).toEqual([])
  })

  it('信任边界：跨站标记拒 403，非 POST 拒 405', async () => {
    const harness = await makeHarness(async () => undefined)
    const crossSite = await harness.request(APPLY_WEB_CONFIG_PATH, 'POST', { 'sec-fetch-site': 'cross-site' })
    expect(crossSite.status).toBe(403)
    expect((await harness.request(APPLY_WEB_CONFIG_PATH, 'GET')).status).toBe(405)
  })
})
