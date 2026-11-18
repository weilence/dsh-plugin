import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SiteDraft, SitesView } from '../../src/shared'

// store 直接消费 api 模块：mock 掉 HTTP 封装，行为以返回视图为准。
const apiMock = vi.hoisted(() => ({
  sites: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  clearToken: vi.fn(),
  test: vi.fn(),
}))

vi.mock('../../src/client/api', () => ({ atlassianApi: apiMock }))

const { AtlassianStore } = await import('../../src/client/store')

const emptyView: SitesView = { sites: [], problems: [] }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('AtlassianStore', () => {
  it('refresh 成功 → view 更新、loading 落定', async () => {
    const store = new AtlassianStore()
    apiMock.sites.mockResolvedValue(emptyView)
    await store.refresh()
    expect(store.getSnapshot().view).toEqual(emptyView)
    expect(store.getSnapshot().loading).toBe(false)
    expect(store.getSnapshot().loadError).toBeNull()
  })

  it('refresh 失败 → loadError 原文', async () => {
    const store = new AtlassianStore()
    apiMock.sites.mockRejectedValue(new Error('HTTP 503'))
    await store.refresh()
    expect(store.getSnapshot().loadError).toBe('HTTP 503')
    expect(store.getSnapshot().loading).toBe(false)
  })

  it('save 成功 → 响应视图即新状态、formError 清空；失败 → formError 原文', async () => {
    const store = new AtlassianStore()
    const savedView: SitesView = { sites: [], problems: [] }
    apiMock.save.mockResolvedValueOnce(savedView)
    const site: SiteDraft = {
      name: 'acme',
      kind: 'cloud',
      atlassianUrl: 'https://acme.atlassian.net',
      email: 'a@b.com',
    }
    const ok = await store.save({ site, token: 'tok' })
    expect(ok).toEqual({ ok: true })
    expect(store.getSnapshot().busy).toBe(false)
    expect(store.getSnapshot().view).toBe(savedView)
    expect(store.getSnapshot().formError).toBeNull()
    expect(apiMock.save).toHaveBeenCalledWith({ site, token: 'tok', previousName: undefined })

    apiMock.save.mockRejectedValueOnce(new Error('站点名「acme」已存在'))
    const fail = await store.save({ site, token: undefined })
    expect(fail).toEqual({ ok: false, reason: '站点名「acme」已存在' })
    expect(store.getSnapshot().formError).toBe('站点名「acme」已存在')
    expect(store.getSnapshot().busy).toBe(false)
  })

  it('remove 失败 → 行错误；成功 → 行错误清空', async () => {
    const store = new AtlassianStore()
    apiMock.remove.mockRejectedValueOnce(new Error('站点「x」不存在'))
    const fail = await store.remove('x')
    expect(fail.ok).toBe(false)
    expect(store.getSnapshot().rowErrors.x).toBe('站点「x」不存在')

    apiMock.remove.mockResolvedValueOnce(emptyView)
    await store.remove('x')
    expect(store.getSnapshot().rowErrors.x).toBeUndefined()
  })

  it('test 结果按站点名落表；transport 失败进行错误', async () => {
    const store = new AtlassianStore()
    const site: SiteDraft = {
      name: 'acme',
      kind: 'server',
      jiraUrl: 'http://jira.x',
      confluenceUrl: 'http://conf.x',
    }
    apiMock.test.mockResolvedValueOnce({
      jira: { ok: true },
      confluence: { ok: false, reason: 'HTTP 401' },
    })
    await store.test(site)
    expect(store.getSnapshot().testing).toBeNull()
    expect(store.getSnapshot().testResults.acme).toEqual({
      jira: { ok: true },
      confluence: { ok: false, reason: 'HTTP 401' },
    })

    apiMock.test.mockRejectedValueOnce(new Error('Atlassian 请求超时（30s）'))
    const outcome = await store.test(site)
    expect(outcome.ok).toBe(false)
    expect(store.getSnapshot().rowErrors.acme).toBe('Atlassian 请求超时（30s）')
  })

  it('notice 走通道投递：订阅者逐次收到，无订阅者丢弃（重开分区不重放）', () => {
    const store = new AtlassianStore()
    store.notices.emit('未挂载')
    const seen: string[] = []
    const unsubscribe = store.notices.subscribe((message) => seen.push(message))
    store.notices.emit('已保存')
    store.notices.emit('已保存')
    unsubscribe()
    store.notices.emit('卸载后')
    expect(seen).toEqual(['已保存', '已保存'])
  })

  it('workspaceCwd 随上报更新，refresh 携带 cwd 兜底', async () => {
    const store = new AtlassianStore()
    apiMock.sites.mockResolvedValue(emptyView)
    store.setWorkspaceCwd('C:/code/acme')
    expect(store.getSnapshot().workspaceCwd).toBe('C:/code/acme')
    await store.refresh()
    expect(apiMock.sites).toHaveBeenCalledWith('C:/code/acme')
    store.setWorkspaceCwd(undefined)
    await store.refresh()
    expect(apiMock.sites).toHaveBeenLastCalledWith(undefined)
  })
})
