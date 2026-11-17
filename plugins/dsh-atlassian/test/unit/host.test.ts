/** host 路由：假 ctx / credentials / configEditor / webServer 上的六路由全链路往返。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../../src/index'
import {
  CLEAR_TOKEN_PATH,
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

function makeHarness(initialSites: unknown, initialTokens: Record<string, string> = {}) {
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse) => Promise<void>>()
  const tools: { name: string; when: unknown }[] = []
  const commands: { name: string }[] = []
  const rowConfig: Record<string, unknown> = { sites: initialSites }
  const entry = { options: { id: ROW_ID, name: '@weilence/dsh-atlassian' } }
  const creds = new Map<string, string>(Object.entries(initialTokens))
  const setCalls: [string, string][] = []
  const unsetCalls: string[] = []
  const entryRow = { entry, inherited: rowConfig, override: {} as Record<string, unknown> }

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
      register: (definition: { name: string }, options: unknown) => {
        tools.push({ name: definition.name, when: (options as { when?: unknown }).when })
        return () => {}
      },
    },
    commands: {
      register: (definition: { name: string }) => {
        commands.push({ name: definition.name })
        return () => {}
      },
    },
    credentials: {
      resolve: async (ref: string) => (creds.has(ref) ? { value: creds.get(ref) } : undefined),
      describe: async (ref: string) =>
        creds.has(ref)
          ? { configured: true, source: 'stored', writable: true }
          : { configured: false, writable: true },
      set: async (ref: string, value: string) => {
        creds.set(ref, value)
        setCalls.push([ref, value])
      },
      unset: async (ref: string) => {
        creds.delete(ref)
        unsetCalls.push(ref)
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

  return { ctx, request, routes, tools, commands, rowConfig, creds, setCalls, unsetCalls }
}

const seedSite: SiteDraft = {
  name: 'acme',
  kind: 'cloud',
  atlassianUrl: 'https://acme.atlassian.net',
  email: 'a@b.com',
}
const serverSeed: SiteDraft = {
  name: 'intra',
  kind: 'server',
  jiraUrl: 'http://jira.intra:8080',
  confluenceUrl: 'http://conf.intra:8090',
}

async function harness(initialSites: unknown = [], tokens: Record<string, string> = {}) {
  const made = makeHarness(initialSites, tokens)
  await apply(made.ctx as unknown as Context)
  return made
}

beforeEach(() => {
  vi.unstubAllGlobals()
})

describe('apply 装配', () => {
  it('注册五个工具（带 when）与 jira/conf 两个命令', async () => {
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    expect(made.tools.map((tool) => tool.name).sort()).toEqual([
      'confluence_get_page',
      'confluence_search',
      'jira_get_attachment',
      'jira_get_issue',
      'jira_search',
    ])
    const when = made.tools[0]?.when as () => boolean
    expect(when()).toBe(true)
    expect(made.commands.map((command) => command.name).sort()).toEqual(['conf', 'jira'])
  })

  it('没有任何站点可用时 when 为 false', async () => {
    const made = await harness([seedSite])
    const when = made.tools[0]?.when as () => boolean
    expect(when()).toBe(false)
  })
})

describe('sites 路由', () => {
  it('GET 视图携带 token 状态', async () => {
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    const res = await made.request('GET', SITES_PATH)
    expect(res.status).toBe(200)
    const view = res.body as unknown as SitesView
    expect(view.sites).toHaveLength(1)
    expect(view.sites[0]?.token.configured).toBe(true)
    expect(view.sites[0]?.token.source).toBe('stored')
  })

  it('GET 带 cwd 查询参数作为工作区兜底（视图正常返回）', async () => {
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    const res = await made.request('GET', `${SITES_PATH}?cwd=${encodeURIComponent('C:\\code\\acme')}`)
    expect(res.status).toBe(200)
    expect((res.body as unknown as SitesView).sites).toHaveLength(1)
  })

  it('GET 非 host → 403', async () => {
    const made = await harness([])
    const res = await made.request('GET', SITES_PATH, undefined, { host: 'evil.example' })
    expect(res.status).toBe(403)
  })
})

describe('cwd 桥路由', () => {
  it('POST 上报 cwd → ok', async () => {
    const made = await harness([])
    const res = await made.request('POST', CWD_PATH, { cwd: 'C:\\code\\acme' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('cwd 缺省 = 工作区未定，同样接受', async () => {
    const made = await harness([])
    const res = await made.request('POST', CWD_PATH, {})
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('GET 方法与非 host → 403', async () => {
    const made = await harness([])
    expect((await made.request('GET', CWD_PATH)).status).toBe(403)
    expect((await made.request('POST', CWD_PATH, { cwd: 'x' }, { host: 'evil.example' })).status).toBe(403)
  })
})

describe('save 路由', () => {
  it('写入站点与凭据，响应即最新视图', async () => {
    const made = await harness([])
    const res = await made.request('POST', SAVE_PATH, { site: seedSite, token: 'tok-1' })
    expect(res.status).toBe(200)
    expect(made.rowConfig.sites).toHaveLength(1)
    expect(made.setCalls).toEqual([['ATLASSIAN_ACME_TOKEN', 'tok-1']])
    const view = res.body as unknown as SitesView
    expect(view.sites[0]?.name).toBe('acme')
    expect(view.sites[0]?.token.configured).toBe(true)
    // 写入后 when 立即可用。
    const when = made.tools[0]?.when as () => boolean
    expect(when()).toBe(true)
  })

  it('改名走 previousName：旧名移除、凭据引用随新名', async () => {
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'old' })
    const renamed = { ...seedSite, name: 'acme2' }
    const res = await made.request('POST', SAVE_PATH, { site: renamed, token: 'new', previousName: 'acme' })
    expect(res.status).toBe(200)
    expect((made.rowConfig.sites as SiteDraft[]).map((site) => site.name)).toEqual(['acme2'])
    expect(made.setCalls).toEqual([['ATLASSIAN_ACME2_TOKEN', 'new']])
  })

  it('default 站点唯一化', async () => {
    const other = { ...serverSeed, name: 'b', default: true }
    const made = await harness([other])
    const res = await made.request('POST', SAVE_PATH, { site: { ...seedSite, default: true } })
    expect(res.status).toBe(200)
    const sites = made.rowConfig.sites as SiteDraft[]
    expect(sites.filter((site) => site.default === true).map((site) => site.name)).toEqual(['acme'])
  })

  it('server 站点写入两份凭据（Jira / Confluence 引用各自独立）', async () => {
    const made = await harness([])
    const res = await made.request('POST', SAVE_PATH, {
      site: serverSeed,
      token: 'jira-pat',
      confluenceToken: 'conf-pat',
    })
    expect(res.status).toBe(200)
    expect(made.setCalls).toEqual([
      ['ATLASSIAN_INTRA_JIRA_TOKEN', 'jira-pat'],
      ['ATLASSIAN_INTRA_CONFLUENCE_TOKEN', 'conf-pat'],
    ])
  })

  it('评论过滤名单随草稿写入配置', async () => {
    const made = await harness([])
    const res = await made.request('POST', SAVE_PATH, {
      site: { ...seedSite, commentExcludeAuthors: ['gitlab', 'ci-bot'] },
    })
    expect(res.status).toBe(200)
    expect((made.rowConfig.sites as SiteDraft[])[0]?.commentExcludeAuthors).toEqual(['gitlab', 'ci-bot'])
    const view = res.body as unknown as SitesView
    expect(view.sites[0]?.commentExcludeAuthors).toEqual(['gitlab', 'ci-bot'])
  })

  it('server 站点省略 confluenceUrl → 400', async () => {
    const made = await harness([])
    const res = await made.request('POST', SAVE_PATH, {
      site: { name: 'intra', kind: 'server', jiraUrl: 'http://j' },
    })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('confluenceUrl')
  })

  it('cloud 站点不接受 confluenceToken', async () => {
    const made = await harness([])
    const res = await made.request('POST', SAVE_PATH, { site: seedSite, confluenceToken: 'x' })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('confluenceToken')
  })

  it('非法草稿 → 400', async () => {
    const made = await harness([])
    const res = await made.request('POST', SAVE_PATH, { site: { ...seedSite, name: 'BAD' } })
    expect(res.status).toBe(400)
    expect(String(res.body.error)).toContain('站点名')
  })

  it('跨站 POST → 403', async () => {
    const made = await harness([])
    const res = await made.request(
      'POST',
      SAVE_PATH,
      { site: seedSite },
      {
        ...TRUSTED,
        'sec-fetch-site': 'cross-site',
      },
    )
    expect(res.status).toBe(403)
  })
})

describe('delete / clear-token 路由', () => {
  it('删除站点并 unset 已存凭据', async () => {
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    const res = await made.request('POST', DELETE_PATH, { name: 'acme' })
    expect(res.status).toBe(200)
    expect(made.rowConfig.sites).toHaveLength(0)
    expect(made.unsetCalls).toEqual(['ATLASSIAN_ACME_TOKEN'])
    expect(made.creds.size).toBe(0)
  })

  it('clearToken 只清凭据不动站点', async () => {
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    const res = await made.request('POST', CLEAR_TOKEN_PATH, { name: 'acme' })
    expect(res.status).toBe(200)
    const view = res.body as unknown as SitesView
    expect(view.sites).toHaveLength(1)
    expect(view.sites[0]?.token.configured).toBe(false)
    expect(made.unsetCalls).toEqual(['ATLASSIAN_ACME_TOKEN'])
    expect((made.rowConfig.sites as SiteDraft[])[0]?.name).toBe('acme')
  })

  it('clearToken product=confluence 清独立凭据引用', async () => {
    const made = await harness([serverSeed], {
      ATLASSIAN_INTRA_JIRA_TOKEN: 'jr',
      ATLASSIAN_INTRA_CONFLUENCE_TOKEN: 'cf',
    })
    const res = await made.request('POST', CLEAR_TOKEN_PATH, { name: 'intra', product: 'confluence' })
    expect(res.status).toBe(200)
    expect(made.unsetCalls).toEqual(['ATLASSIAN_INTRA_CONFLUENCE_TOKEN'])
    const view = res.body as unknown as SitesView
    expect(view.sites[0]?.token.configured).toBe(true)
    expect(view.sites[0]?.confluenceToken.configured).toBe(false)
  })
})

describe('test 路由', () => {
  it('两产品各自 ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string | URL, _init?: RequestInit) => new Response('{}', { status: 200 })),
    )
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    const res = await made.request('POST', TEST_PATH, { site: seedSite })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ jira: { ok: true }, confluence: { ok: true } })
  })

  it('探测失败是结论不是异常：200 + 每 product 的 reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ errorMessages: ['nope'] }), { status: 401 }),
      ),
    )
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'tok' })
    const res = await made.request('POST', TEST_PATH, { site: seedSite })
    expect(res.status).toBe(200)
    expect((res.body.jira as { ok: boolean }).ok).toBe(false)
    expect(String((res.body.jira as { reason?: string }).reason)).toContain('凭据无效')
    expect((res.body.confluence as { ok: boolean }).ok).toBe(false)
  })

  it('token 覆盖值优先生效（保存前验证新 token）', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL, init?: RequestInit) => new Response('{}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const made = await harness([seedSite], { ATLASSIAN_ACME_TOKEN: 'stored' })
    await made.request('POST', TEST_PATH, { site: seedSite, token: 'fresh' })
    const headers = (fetchSpy.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>
    expect(headers.authorization).toBe(`Basic ${Buffer.from('a@b.com:fresh').toString('base64')}`)
  })
})
