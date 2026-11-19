/** 面板 store：mock api 模块，走真实 store 状态机（含 workspaceCwd 随附）。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SitesView } from '../../src/shared'

vi.mock('../../src/client/api', () => ({
  gitlabApi: {
    sites: vi.fn(),
    reportCwd: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    test: vi.fn(),
  },
}))

import { gitlabApi } from '../../src/client/api'
import { GitlabStore } from '../../src/client/store'

const mocked = vi.mocked(gitlabApi)

const view: SitesView = {
  sites: [{ name: 'yamu', url: 'https://gitlab.yamu.com' }],
  problems: [],
  glab: { path: '/opt/homebrew/bin/glab', version: 'glab 1.124.0' },
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GitlabStore', () => {
  it('refresh 成功写入视图并携带 workspaceCwd 兜底', async () => {
    mocked.sites.mockResolvedValue(view)
    const store = new GitlabStore()
    store.setWorkspaceCwd('/code/yamu')
    await store.refresh()
    expect(mocked.sites).toHaveBeenCalledWith('/code/yamu')
    expect(store.getSnapshot().view).toEqual(view)
    expect(store.getSnapshot().loading).toBe(false)
  })

  it('refresh 失败写 loadError，不抛出', async () => {
    mocked.sites.mockRejectedValue(new Error('网络断了'))
    const store = new GitlabStore()
    await store.refresh()
    expect(store.getSnapshot().loadError).toBe('网络断了')
    expect(store.getSnapshot().view).toBeNull()
  })

  it('save 成功返回 ok 并更新视图；失败写 formError', async () => {
    const store = new GitlabStore()
    mocked.save.mockResolvedValueOnce(view)
    const ok = await store.save({ site: { name: 'yamu', url: 'https://gitlab.yamu.com' } })
    expect(ok).toEqual({ ok: true })
    expect(store.getSnapshot().view).toEqual(view)
    mocked.save.mockRejectedValueOnce(new Error('重名'))
    const bad = await store.save({ site: { name: 'yamu', url: 'https://gitlab.yamu.com' } })
    expect(bad.ok).toBe(false)
    expect(store.getSnapshot().formError).toBe('重名')
  })

  it('test 结果按站点名归档；失败写 rowErrors', async () => {
    const store = new GitlabStore()
    const site = { name: 'yamu', url: 'https://gitlab.yamu.com' }
    mocked.test.mockResolvedValueOnce({ ok: true, user: 'luowei' })
    await store.test(site)
    expect(store.getSnapshot().testResults['yamu']).toEqual({ ok: true, user: 'luowei' })
    mocked.test.mockRejectedValueOnce(new Error('探测失败'))
    await store.test(site)
    expect(store.getSnapshot().rowErrors['yamu']).toBe('探测失败')
    expect(store.getSnapshot().testing).toBeNull()
  })

  it('remove 失败按站点名写 rowErrors；成功清空该行错误', async () => {
    const store = new GitlabStore()
    mocked.remove.mockRejectedValueOnce(new Error('不存在'))
    await store.remove('yamu')
    expect(store.getSnapshot().rowErrors['yamu']).toBe('不存在')
    mocked.remove.mockResolvedValueOnce(view)
    await store.remove('yamu')
    expect(store.getSnapshot().rowErrors['yamu']).toBeUndefined()
  })

  it('notices：有订阅者即投递原文，无订阅者直接丢弃', () => {
    const store = new GitlabStore()
    const received: string[] = []
    const unsubscribe = store.notices.subscribe((message) => received.push(message))
    store.notices.emit('已保存')
    store.notices.emit('再保存')
    expect(received).toEqual(['已保存', '再保存'])
    // 分区卸载（退订）后迟到的 emit 无处显示，也不得排队等待重放。
    unsubscribe()
    store.notices.emit('迟到反馈')
    expect(received).toHaveLength(2)
  })

  it('setWorkspaceCwd：相同 cwd 不触发通知', () => {
    const store = new GitlabStore()
    let notifications = 0
    store.subscribe(() => {
      notifications += 1
    })
    store.setWorkspaceCwd('/code/yamu')
    const afterFirst = notifications
    store.setWorkspaceCwd('/code/yamu')
    expect(notifications).toBe(afterFirst)
    store.setWorkspaceCwd('/other')
    expect(notifications).toBe(afterFirst + 1)
  })
})
