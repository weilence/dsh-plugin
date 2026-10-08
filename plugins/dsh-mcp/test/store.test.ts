import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mcpApi } from '../src/client/api'
import { McpStore } from '../src/client/store'
import type { ListResponse, McpLiveState, McpRow } from '../src/shared'

const POLL_MS = 2000

const liveRow = (live: McpLiveState | null): McpRow => ({
  id: 'mcp-demo',
  scope: 'profile',
  config: { serverName: 'demo', transport: 'stdio', command: 'demo' },
  disabled: false,
  editable: true,
  live,
})

const listResponse = (servers: McpRow[], hotApply = true): ListResponse => ({
  profileName: 'default',
  patchPaths: { profile: '/tmp/profile/cordis.patch.yml', home: '/tmp/home/cordis.patch.yml' },
  hotApply,
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

  it('待生效行（live 为 null）在 HMR 在场时轮询等条目出现，HMR 缺席时不轮询', async () => {
    const list = vi
      .spyOn(mcpApi, 'list')
      .mockResolvedValueOnce(listResponse([liveRow(null)], true))
      .mockResolvedValue(listResponse([liveRow({ status: 'pending', tools: [] })], true))

    const store = new McpStore()
    const unsubscribe = store.subscribe(() => {})
    await store.refresh()
    expect(list).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(list).toHaveBeenCalledTimes(2)
    unsubscribe()

    // HMR 缺席：文件行不会在线生效，等待没有意义。
    const cold = vi.spyOn(mcpApi, 'list').mockResolvedValue(listResponse([liveRow(null)], false))
    const coldStore = new McpStore()
    const coldUnsubscribe = coldStore.subscribe(() => {})
    await coldStore.refresh()
    const coldCalls = cold.mock.calls.length
    await vi.advanceTimersByTimeAsync(POLL_MS * 5)
    expect(cold).toHaveBeenCalledTimes(coldCalls)
    coldUnsubscribe()
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
})
