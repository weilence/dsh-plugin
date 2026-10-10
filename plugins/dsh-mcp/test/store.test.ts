import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApi } from '../src/client/api'
import { McpStore } from '../src/client/store'
import type { ListResponse, McpLiveState, McpRow } from '../src/shared'

const POLL_MS = 2000

const liveRow = (live: McpLiveState | null, scope: McpRow['scope'] = 'global'): McpRow => ({
  scope,
  name: 'demo',
  config: { serverName: 'demo', transport: 'stdio', command: 'demo' },
  disabled: false,
  live,
})

const listResponse = (servers: McpRow[]): ListResponse => ({
  profileName: 'default',
  globalPath: '/tmp/home/mcp.json',
  workspacePath: null,
  warnings: [],
  revisions: { global: 'rev', workspace: null },
  servers,
})

describe('McpStore 过渡态轮询', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('行处于连接中时持续轮询，直到 active 落定后停止', async () => {
    const list = vi
      .spyOn(mcpApi, 'list')
      .mockResolvedValueOnce(listResponse([liveRow({ status: 'loading', tools: [] })]))
      .mockResolvedValueOnce(listResponse([liveRow({ status: 'loading', tools: [] })]))
      .mockResolvedValue(listResponse([liveRow({ status: 'active', tools: ['mcp__demo__ping'] })]))

    const store = new McpStore()
    const unsubscribe = store.subscribe(() => {})
    await store.refresh()
    expect(store.getSnapshot().list?.servers[0]?.live?.status).toBe('loading')
    expect(list).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(list).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(store.getSnapshot().list?.servers[0]?.live?.status).toBe('active')

    const settledCalls = list.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(list).toHaveBeenCalledTimes(settledCalls)

    unsubscribe()
  })

  it('live 为 null（loader 缺席 / 未挂载）不轮询——刷新才有意义', async () => {
    const list = vi.spyOn(mcpApi, 'list').mockResolvedValue(listResponse([liveRow(null)]))
    const store = new McpStore()
    const unsubscribe = store.subscribe(() => {})
    await store.refresh()
    const calls = list.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(list).toHaveBeenCalledTimes(calls)
    unsubscribe()
  })

  it('面板关闭（无订阅者）后停止轮询，重新挂载时恢复', async () => {
    const list = vi
      .spyOn(mcpApi, 'list')
      .mockResolvedValue(listResponse([liveRow({ status: 'loading', tools: [] })]))

    const store = new McpStore()
    const unsubscribe = store.subscribe(() => {})
    await store.refresh()
    unsubscribe()
    const callsAtClose = list.mock.calls.length

    await vi.advanceTimersByTimeAsync(POLL_MS * 3)
    expect(list).toHaveBeenCalledTimes(callsAtClose)

    store.subscribe(() => {})
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(list).toHaveBeenCalledTimes(callsAtClose + 1)
  })

  it('主视图 cwd 变化触发重拉并把 cwd 带进 list 请求；未变不重拉', async () => {
    const list = vi
      .spyOn(mcpApi, 'list')
      .mockResolvedValue(listResponse([liveRow({ status: 'active', tools: [] }, 'workspace')]))

    const store = new McpStore()
    const unsubscribe = store.subscribe(() => {})
    await store.refresh()
    expect(list.mock.calls[0]).toEqual([undefined])

    await store.setWorkspaceCwd('/work/a')
    expect(list).toHaveBeenCalledTimes(2)
    expect(list.mock.calls[1]).toEqual(['/work/a'])

    // 同值短路。
    await store.setWorkspaceCwd('/work/a')
    expect(list).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('保存动作按档位携带快照 revision 与 cwd', async () => {
    vi.spyOn(mcpApi, 'list').mockResolvedValue(listResponse([liveRow({ status: 'active', tools: [] })]))
    const save = vi.spyOn(mcpApi, 'save').mockResolvedValue({ scope: 'global', name: 'demo' })
    const store = new McpStore()
    const unsubscribe = store.subscribe(() => {})
    await store.refresh()
    await store.setWorkspaceCwd('/work/a')
    const ok = await store.save({
      scope: 'global',
      name: 'demo',
      config: { transport: 'stdio', serverName: 'demo', command: 'npx' },
    })
    expect(ok).toBe(true)
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      scope: 'global',
      name: 'demo',
      cwd: '/work/a',
      revision: 'rev',
    })
    unsubscribe()
  })
})
