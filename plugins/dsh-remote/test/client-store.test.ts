import { describe, expect, it, vi } from 'vitest'
import { RemoteStore } from '../src/client/store'
import type { PanelMessage } from '../src/client/locales'
import { messageText } from '../src/client/locales'
import type { ConnRow, StateResponse } from '../src/shared'
import { makeT } from './i18n'

// store 走 HTTP 封装取状态；这里换成可控的顺序桩（refresh 链路其余为真实逻辑）。
const api = vi.hoisted(() => ({
  state: vi.fn(),
  localRows: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  remoteInventory: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  sync: vi.fn(),
}))

vi.mock('../src/client/api', () => ({ remoteApi: api }))

/** 快照消息 → 展示文本（与面板渲染同一取词路径）。 */
const text = (message: PanelMessage | null): string | null =>
  message === null ? null : messageText(message, makeT())

function connRow(id: string, state: Partial<ConnRow['state']> = {}): ConnRow {
  return {
    id,
    label: `连接 ${id}`,
    sshAlias: 'dev-box',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    state: {
      phase: 'idle',
      op: null,
      running: null,
      error: null,
      lastSync: { skills: null, mcp: null, plugins: null, prompts: null },
      ...state,
    },
  }
}

function stateResponse(connections: ConnRow[]): StateResponse {
  return { env: { profileName: 'default', home: '/home', ssh: true, tar: true }, connections }
}

describe('RemoteStore 阶段迁移检测', () => {
  it('starting → running 发连接成功 toast，文案不自动打开远端页面', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { phase: 'starting' })]))
    await store.refresh()
    expect(store.getSnapshot().notice).toBeNull()

    api.state.mockResolvedValueOnce(
      stateResponse([
        connRow('dev', {
          phase: 'running',
          running: {
            url: 'http://127.0.0.1:18731',
            localPort: 18731,
            remotePort: 18730,
            pid: 42,
            since: '2026-01-01T00:00:00.000Z',
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(store.getSnapshot().notice)).toBe('已连接「连接 dev」——点卡片上的「打开」进入远端页面')
    store.stopPolling()
  })

  it('同步 op 结束按类别发完成摘要（含跳过计数）', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { phase: 'running', op: { kind: 'sync-skills' } })]),
    )
    await store.refresh()
    expect(store.getSnapshot().notice).toBeNull()

    api.state.mockResolvedValueOnce(
      stateResponse([
        connRow('dev', {
          phase: 'running',
          lastSync: {
            skills: { at: '2026-01-02T00:00:00.000Z', pushed: 2, skipped: 1 },
            mcp: null,
            plugins: null,
            prompts: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(store.getSnapshot().notice)).toBe('同步 Skills 完成：推送 2 · 跳过 1（已一致）')
    store.stopPolling()
  })

  it('同步无跳过时摘要不带跳过段', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { op: { kind: 'sync-plugins' } })]))
    await store.refresh()
    api.state.mockResolvedValueOnce(
      stateResponse([
        connRow('dev', {
          lastSync: {
            skills: null,
            mcp: null,
            plugins: { at: '2026-01-02T00:00:00.000Z', installed: ['a'], skipped: [] },
            prompts: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(store.getSnapshot().notice)).toBe('同步插件完成：安装 1')
    store.stopPolling()
  })

  it('同步失败时错误原文作为 detail 原样并入（不翻译外部事实）', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { op: { kind: 'sync-mcp' } })]))
    await store.refresh()
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { error: { message: 'ssh: connect refused', kind: 'unreachable' } })]),
    )
    await store.refresh()
    expect(text(store.getSnapshot().notice)).toBe('同步MCP失败：ssh: connect refused')
    store.stopPolling()
  })

  it('lastSync 摘要缺失时退回类别的通用完成文案', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { op: { kind: 'sync-prompts' } })]))
    await store.refresh()
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev')]))
    await store.refresh()
    expect(text(store.getSnapshot().notice)).toBe('同步提示词完成')
    store.stopPolling()
  })
})

describe('RemoteStore 写操作提示', () => {
  it('保存按新建 / 编辑分别提示，错误走 text 原样', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValue(stateResponse([]))

    api.save.mockResolvedValueOnce({ id: 'a' })
    expect(await store.save({ label: 'a', sshAlias: 'box' })).toBe(true)
    expect(text(store.getSnapshot().notice)).toBe('已创建连接')

    api.save.mockResolvedValueOnce({ id: 'a' })
    expect(await store.save({ id: 'a', label: 'a2', sshAlias: 'box' })).toBe(true)
    expect(text(store.getSnapshot().notice)).toBe('已保存连接')

    api.save.mockRejectedValueOnce(new Error('boom'))
    expect(await store.save({ id: 'a', label: 'a3', sshAlias: 'box' })).toBe(false)
    expect(text(store.getSnapshot().error)).toBe('boom')
    store.stopPolling()
  })

  it('删除成功提示', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValue(stateResponse([]))
    api.remove.mockResolvedValueOnce({ removed: true })
    expect(await store.remove('a')).toBe(true)
    expect(text(store.getSnapshot().notice)).toBe('已删除连接')
    store.stopPolling()
  })

  it('状态读取失败时错误是 text 描述子（Host errMsg 不翻译）', async () => {
    const store = new RemoteStore()
    api.state.mockRejectedValueOnce(new Error('network down'))
    await store.refresh()
    expect(store.getSnapshot().status).toBe('error')
    expect(text(store.getSnapshot().error)).toBe('network down')
    store.stopPolling()
  })
})
