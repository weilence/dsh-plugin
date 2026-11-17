import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTools, type ToolDeps } from '../../src/tools'

const site = {
  name: 'acme',
  kind: 'cloud' as const,
  atlassianUrl: 'https://acme.atlassian.net',
  email: 'a@b.com',
}

type ToolExec = Parameters<ReturnType<typeof buildTools>[number]['execute']>[1]

/** 工具体只消费 signal：其余 ToolRunContext 成员对本实现不可达。 */
const fakeExec = (): ToolExec => ({ signal: new AbortController().signal }) as unknown as ToolExec

function fakeDeps(): ToolDeps & { requireCalls: [string | undefined, string | undefined][] } {
  const requireCalls: [string | undefined, string | undefined][] = []
  return {
    requireCalls,
    requireSite(name, hint) {
      requireCalls.push([name, hint])
      return site
    },
    async jiraTokenOf() {
      return 'jira-tok'
    },
    async confluenceTokenOf() {
      return 'conf-tok'
    },
  }
}

function canned(body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildTools', () => {
  it('四个只读工具，名称固定', () => {
    const tools = buildTools(fakeDeps())
    expect(tools.map((tool) => tool.name)).toEqual([
      'jira_search',
      'jira_get_issue',
      'confluence_search',
      'confluence_get_page',
    ])
  })

  it('jira_search execute：走 requireSite/tokenOf，产物 lossless（undefined 字段被剔除）', async () => {
    const deps = fakeDeps()
    canned({
      issues: [{ key: 'P-1', fields: { summary: '第一', status: { name: 'Open' }, assignee: null } }],
      total: 1,
    })
    const [search] = buildTools(deps)
    const value = (await search.execute({ jql: 'x', limit: 3 }, fakeExec())) as {
      site: string
      total: number
      truncated: boolean
      issues: Record<string, unknown>[]
    }
    expect(deps.requireCalls).toEqual([[undefined, 'x']])
    expect(value).toEqual({
      site: 'acme',
      total: 1,
      truncated: false,
      issues: [{ key: 'P-1', summary: '第一', status: 'Open', url: 'https://acme.atlassian.net/browse/P-1' }],
    })
    expect(Object.keys(value.issues[0] ?? {})).not.toContain('assignee')
  })

  it('render 输出模型文本，presentationMeta 携带卡片事实', async () => {
    canned({ issues: [{ key: 'P-1', fields: { summary: '第一', status: { name: 'Open' } } }], total: 1 })
    const [search] = buildTools(fakeDeps())
    const value = (await search.execute({ jql: 'x' }, fakeExec())) as {
      site: string
      total: number
      truncated: boolean
      issues: { key: string; summary: string; url: string }[]
    }
    const blocks = search.output.render({}, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ type: 'text' })
    const text = (blocks[0] as { text: string }).text
    expect(text).toContain('[P-1] 第一')
    expect(text).toContain('https://acme.atlassian.net/browse/P-1')
    const meta = search.output.presentationMeta?.({}, value) as { kind: string; issues: unknown[] }
    expect(meta.kind).toBe('jira-search')
    expect(meta.issues).toHaveLength(1)
  })

  it('limit 越界收敛到上限', async () => {
    const fetchSpy = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        new Response(JSON.stringify({ issues: [], total: 0 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const [search] = buildTools(fakeDeps())
    await search.execute({ jql: 'x', limit: 999 }, fakeExec())
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as { maxResults: number }
    expect(body.maxResults).toBe(50)
  })

  it('requireSite 的失败（未配站点）直接上抛为工具失败', async () => {
    const [search] = buildTools({
      requireSite: () => {
        throw new Error('未配置任何 Atlassian 站点：请到设置页添加站点并配置 token')
      },
      jiraTokenOf: async () => 'tok',
      confluenceTokenOf: async () => 'tok',
    })
    await expect(search.execute({ jql: 'x' }, fakeExec())).rejects.toThrow(/未配置任何 Atlassian 站点/)
  })

  it('confluence_get_page execute：offset/maxChars 透传', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: '1',
            title: '页',
            space: { key: 'DEV', name: '研发' },
            version: { number: 1 },
            body: { storage: { value: '<p>正文内容很多</p>' } },
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', fetchSpy)
    const tools = buildTools(fakeDeps())
    const page = tools[3]
    const value = (await page.execute({ id: '1', offset: 2 }, fakeExec())) as {
      body: string
      offset: number
      truncated: boolean
    }
    expect(value.body).toBe('内容很多')
    expect(value.offset).toBe(2)
    expect(value.truncated).toBe(false)
  })

  it('requireSite 的 hint：工单号 / JQL / CQL 随调用传入，页面 id 不带', async () => {
    canned({ issues: [], total: 0 })
    const deps = fakeDeps()
    const [search, getIssue, confSearch, confPage] = buildTools(deps)
    await search.execute({ jql: 'project = ABC AND assignee = me()' }, fakeExec())
    await getIssue.execute({ key: 'DEF-9' }, fakeExec())
    await confSearch.execute({ cql: 'type=page AND text ~ "部署"' }, fakeExec())
    await confPage.execute({ id: '100' }, fakeExec())
    expect(deps.requireCalls).toEqual([
      [undefined, 'project = ABC AND assignee = me()'],
      [undefined, 'DEF-9'],
      [undefined, 'type=page AND text ~ "部署"'],
      [undefined, undefined],
    ])
  })

  it('四个工具的产物满足各自 output schema 形状（宿主管道强校验，本地护栏防漂移）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        const target = String(url)
        if (target.includes('/comment?')) {
          return new Response(JSON.stringify({ comments: [], total: 0 }), { status: 200 })
        }
        if (target.includes('/search/jql')) {
          return new Response(
            JSON.stringify({ issues: [{ key: 'P-1', fields: { summary: '第一' } }], total: 1 }),
            { status: 200 },
          )
        }
        if (target.includes('/issue/')) {
          return new Response(JSON.stringify({ key: 'P-9', fields: { summary: '详情' } }), { status: 200 })
        }
        if (target.includes('rest/api/search')) {
          return new Response(
            JSON.stringify({
              results: [{ content: { id: '7', title: '页', type: 'page' }, excerpt: '', url: '/x' }],
              totalSize: 1,
            }),
            { status: 200 },
          )
        }
        return new Response(
          JSON.stringify({
            id: '7',
            title: '页',
            space: { key: 'DEV' },
            body: { storage: { value: '<p>正文</p>' } },
          }),
          { status: 200 },
        )
      }),
    )
    const tools = buildTools(fakeDeps())
    const [search, getIssue, confSearch, confPage] = tools
    const results: [string, unknown][] = [
      ['jira_search', await search.execute({ jql: 'x' }, fakeExec())],
      ['jira_get_issue', await getIssue.execute({ key: 'P-9' }, fakeExec())],
      ['confluence_search', await confSearch.execute({ cql: 'text ~ "x"' }, fakeExec())],
      ['confluence_get_page', await confPage.execute({ id: '7' }, fakeExec())],
    ]
    for (const [name, value] of results) {
      const tool = tools.find((entry) => entry.name === name)
      assertConforms(tool?.output.schema, value, name)
    }
  })
})

type SchemaNode = {
  type?: string
  /** defineTool 把 DSL 归一化为标准 JSON Schema：required 是对象节点上的键名数组。 */
  required?: string[]
  properties?: Record<string, unknown>
  items?: unknown
  oneOf?: unknown[]
  additionalProperties?: boolean
}

/** 按宿主统一 schema DSL 递归核对产物：required 缺席与 additionalProperties 之外的键都是宿主管道会拒绝的漂移。 */
function assertConforms(schema: unknown, value: unknown, path: string): void {
  const node = schema as SchemaNode
  if (node.oneOf !== undefined) {
    const misses: string[] = []
    for (const branch of node.oneOf) {
      try {
        assertConforms(branch, value, path)
        return
      } catch (error) {
        misses.push(String(error))
      }
    }
    throw new Error(`${path} 不满足任何 oneOf 分支：${misses.join('；')}`)
  }
  switch (node.type) {
    case 'string':
      expect(value, path).toBeTypeOf('string')
      return
    case 'number':
    case 'integer':
      expect(value, path).toBeTypeOf('number')
      return
    case 'boolean':
      expect(value, path).toBeTypeOf('boolean')
      return
    case 'null':
      expect(value, path).toBeNull()
      return
    case 'array': {
      expect(Array.isArray(value), path).toBe(true)
      const list = value as unknown[]
      for (const [index, item] of list.entries()) assertConforms(node.items, item, `${path}[${index}]`)
      return
    }
    case 'object': {
      const record = value as Record<string, unknown> | null
      expect(record !== null && typeof record === 'object' && !Array.isArray(record), path).toBe(true)
      const present = record ?? {}
      const props = node.properties ?? {}
      for (const [key, prop] of Object.entries(props)) {
        if (present[key] !== undefined) assertConforms(prop, present[key], `${path}.${key}`)
      }
      for (const key of node.required ?? []) {
        expect(present[key] !== undefined, `${path}.${key} 必填缺失`).toBe(true)
      }
      if (node.additionalProperties === false) {
        const extra = Object.keys(present).filter((key) => !(key in props))
        expect(extra, `${path} 多出的键`).toEqual([])
      }
      return
    }
    default:
      return
  }
}
