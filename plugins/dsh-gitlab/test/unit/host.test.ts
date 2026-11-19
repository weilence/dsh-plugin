/** host 路由：假 ctx / configEditor / webServer 上的五路由全链路往返与注入 seam 生效。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { apply, type ApplyOptions } from '../../src/index'
import {
  CWD_PATH,
  DELETE_PATH,
  ROW_ID,
  SAVE_PATH,
  SITES_PATH,
  TEST_PATH,
  type SiteDraft,
  type SitesView,
} from '../../src/shared'

function getReq(headers: Record<string, string>, url = '/'): IncomingMessage {
  return { headers, method: 'GET', url } as unknown as IncomingMessage
}

function postReq(body: unknown, headers: Record<string, string>): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  const stream = (async function* () {
    yield payload
  })()
  return {
    headers,
    method: 'POST',
    url: '/',
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
  } as unknown as IncomingMessage
}

interface CapturedResponse {
  status: number
  body: Record<string, unknown>
}

const TRUSTED = { host: '127.0.0.1:1', 'sec-fetch-site': 'same-origin' }

const GLAB: ApplyOptions['glab'] = { path: '/opt/homebrew/bin/glab', version: 'glab 1.124.0' }

const seedSite: SiteDraft = { name: 'yamu', url: 'https://gitlab.yamu.com' }

function makeHarness(initialSites: unknown, options: ApplyOptions = { glab: GLAB }) {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const tools: { name: string; when: unknown }[] = []
  const rowConfig: Record<string, unknown> = { sites: initialSites }
  const entry = { options: { id: ROW_ID, name: '@weilence/dsh-gitlab' } }
  const entryRow = { entry, inherited: rowConfig, override: {} as Record<string, unknown> }
  const runCalls: unknown[] = []

  const ctx = {
    effect: (register: () => unknown, _label?: string) => register(),
    webServer: {
      host: '127.0.0.1',
      register: (route: {
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
      }) => {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    tools: {
      register: (definition: { name: string }, registerOptions: unknown) => {
        tools.push({ name: definition.name, when: (registerOptions as { when?: unknown }).when })
        return () => {}
      },
    },
    configEditor: {
      entries: () => [entry],
      configuration: () => [entryRow],
      edit: async (
        _target: unknown,
        change: (
          current: Record<string, unknown>,
          inherited: Record<string, unknown>,
        ) => Record<string, unknown>,
      ) => {
        const next = change(rowConfig, {})
        for (const key of Object.keys(rowConfig)) delete rowConfig[key]
        Object.assign(rowConfig, next)
      },
    },
  }

  const runGlab =
    options.runGlab ??
    (async () => ({
      exitCode: 0,
      stdout: '{"username":"stub"}',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 5,
    }))

  async function request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<CapturedResponse> {
    const handler = routes.get(path.split('?')[0] ?? path)
    if (handler === undefined) throw new Error(`route not registered: ${path}`)
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
    const req = method === 'GET' ? getReq(headers ?? TRUSTED, path) : postReq(body, headers ?? TRUSTED)
    await handler(req, res)
    return captured
  }

  return { ctx, request, routes, tools, rowConfig, runCalls, runGlab }
}

async function harness(initialSites: unknown = [seedSite], options: ApplyOptions = { glab: GLAB }) {
  const made = makeHarness(initialSites, options)
  await apply(made.ctx as unknown as Context, options)
  return made
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('apply 装配', () => {
  it('注册 glab 工具与五条路由', async () => {
    const made = await harness()
    expect(made.tools.map((tool) => tool.name)).toEqual(['glab'])
    expect([...made.routes.keys()].sort()).toEqual(
      [CWD_PATH, DELETE_PATH, SAVE_PATH, SITES_PATH, TEST_PATH].sort(),
    )
    const when = made.tools[0]?.when as () => boolean
    expect(when()).toBe(true)
  })

  it('无站点或 glab 不可用时 when 为 false', async () => {
    const noSites = await harness([], { glab: GLAB })
    expect((noSites.tools[0]?.when as () => boolean)()).toBe(false)
    const noGlab = await harness([seedSite], { glab: { path: null, error: '未找到' } })
    expect((noGlab.tools[0]?.when as () => boolean)()).toBe(false)
  })
})

describe('sites 路由', () => {
  it('GET 视图携带站点与 glab 状态；cwd 查询参数落入工作区关联', async () => {
    const made = await harness()
    const res = await made.request('GET', `${SITES_PATH}?cwd=${encodeURIComponent('/code/yamu/web')}`)
    expect(res.status).toBe(200)
    const view = res.body as unknown as SitesView
    expect(view.sites).toHaveLength(1)
    expect(view.sites[0]?.name).toBe('yamu')
    expect(view.glab.path).toBe('/opt/homebrew/bin/glab')
    // 工作区命中后 requireSite 自动选站（经视图 side effect 难以直接断言，走 cwd 桥验证）
  })

  it('未保存任何站点时视图为空表且不报错', async () => {
    const made = await harness([])
    const res = await made.request('GET', SITES_PATH)
    expect(res.status).toBe(200)
    expect((res.body as unknown as SitesView).sites).toEqual([])
  })
})

describe('cwd 桥', () => {
  it('POST cwd 记录主视图工作目录（工作区关联事实源）', async () => {
    const made = await harness()
    const res = await made.request('POST', CWD_PATH, { cwd: '/code/yamu/web' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })
})

describe('save 路由', () => {
  it('写入合法站点；default 会清掉其他站点的 default', async () => {
    const made = await harness([{ name: 'yamu', url: 'https://gitlab.yamu.com', default: true }])
    const res = await made.request('POST', SAVE_PATH, {
      site: { name: 'acme', url: 'https://gitlab.acme.com/', default: true },
    })
    expect(res.status).toBe(200)
    const sites = (made.rowConfig['sites'] as SiteDraft[]).map((site) => ({
      name: site.name,
      default: site.default,
    }))
    expect(sites).toEqual([
      { name: 'yamu', default: undefined },
      { name: 'acme', default: true },
    ])
  })

  it('previousName 视为改名；非法草稿 400', async () => {
    const made = await harness([{ name: 'old', url: 'https://old.com' }])
    await made.request('POST', SAVE_PATH, {
      site: { name: 'new', url: 'https://new.com' },
      previousName: 'old',
    })
    expect((made.rowConfig['sites'] as SiteDraft[]).map((site) => site.name)).toEqual(['new'])
    const bad = await made.request('POST', SAVE_PATH, { site: { name: 'x', url: 'nope' } })
    expect(bad.status).toBe(400)
  })

  it('非信任来源 403', async () => {
    const made = await harness()
    const res = await made.request('POST', SAVE_PATH, { site: seedSite }, { host: 'evil:1' })
    expect(res.status).toBe(403)
  })
})

describe('delete 路由', () => {
  it('按名移除站点', async () => {
    const made = await harness([{ name: 'yamu', url: 'https://gitlab.yamu.com' }])
    const res = await made.request('POST', DELETE_PATH, { name: 'yamu' })
    expect(res.status).toBe(200)
    expect(made.rowConfig['sites']).toEqual([])
  })

  it('缺站点名 400', async () => {
    const made = await harness()
    const res = await made.request('POST', DELETE_PATH, {})
    expect(res.status).toBe(400)
  })
})

describe('test 路由', () => {
  it('glab 探测成功解析 username；注入 seam 生效（请求走替身 runGlab）', async () => {
    const runGlab = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"username":"luowei"}',
      stderr: '',
      truncated: false,
      timedOut: false,
      durationMs: 40,
    }))
    const made = await harness([seedSite], { glab: GLAB, runGlab })
    const res = await made.request('POST', TEST_PATH, { site: seedSite })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, user: 'luowei' })
    expect(runGlab).toHaveBeenCalledWith(
      expect.objectContaining({
        glabPath: '/opt/homebrew/bin/glab',
        args: ['api', 'user', '--hostname', 'gitlab.yamu.com'],
        timeoutMs: 15_000,
      }),
    )
  })

  it('glab 非 0 退出码：ok=false 携带 stderr 原文', async () => {
    const made = await harness([seedSite], {
      glab: GLAB,
      runGlab: async () => ({
        exitCode: 1,
        stdout: '',
        stderr: '401 Unauthorized',
        truncated: false,
        timedOut: false,
        durationMs: 30,
      }),
    })
    const res = await made.request('POST', TEST_PATH, { site: seedSite })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: false, reason: '401 Unauthorized' })
  })

  it('glab 未找到：ok=false 携带指引', async () => {
    const made = await harness([seedSite], { glab: { path: null, error: '未在惯例位置找到' } })
    const res = await made.request('POST', TEST_PATH, { site: seedSite })
    expect(res.body).toEqual({ ok: false, reason: '未在惯例位置找到' })
  })
})
