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
})
