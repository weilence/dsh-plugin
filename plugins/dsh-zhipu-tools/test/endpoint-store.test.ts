/** 端点面板 store 与投影：刷新、写入流程与状态文案。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EndpointStatusView } from '../src/shared'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  applyWebConfig: vi.fn(),
}))

vi.mock('../src/client/api', () => ({
  endpointApi: { status: mocks.status, applyWebConfig: mocks.applyWebConfig },
}))

import { EndpointStore } from '../src/client/store'
import { projectEndpoint } from '../src/client/view'
import { makeT } from './i18n'

const t = makeT()

const view = (overrides: Partial<EndpointStatusView> = {}): EndpointStatusView => ({
  baseUrl: 'http://127.0.0.1:39617',
  port: 39617,
  failure: null,
  credential: { configured: true, failure: undefined },
  fetchBackend: 'zhipu-reader',
  patchMtimeMs: 123,
  ...overrides,
})

const listeningView = (): EndpointStatusView => view()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockResolvedValue(listeningView())
  mocks.applyWebConfig.mockResolvedValue(undefined)
})

describe('EndpointStore', () => {
  it('刷新写入视图，错误进入 error 态', async () => {
    const store = new EndpointStore(t)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', view: listeningView() })
    mocks.status.mockRejectedValue(new Error('宿主离线'))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: '宿主离线' })
  })

  it('apply 成功：带 patch 基线发起请求，Toast 提示并补偿刷新两次', async () => {
    vi.useFakeTimers()
    try {
      const store = new EndpointStore(t)
      await store.refresh()
      await store.apply()
      expect(mocks.applyWebConfig).toHaveBeenCalledWith({ expectedMtimeMs: 123 })
      expect(store.getSnapshot().notice).toContain('写入')
      expect(store.getSnapshot().applyError).toBeNull()
      await vi.advanceTimersByTimeAsync(1_200)
      await vi.advanceTimersByTimeAsync(2_800)
      // 初始刷新 1 次 + 补偿刷新 2 次。
      expect(mocks.status).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('apply 失败：原文留在按钮旁错误行，不出 Toast', async () => {
    const store = new EndpointStore(t)
    await store.refresh()
    mocks.applyWebConfig.mockRejectedValue(new Error('patch 配置文件已被外部修改，请刷新面板后重试'))
    await store.apply()
    const snapshot = store.getSnapshot()
    expect(snapshot.applyError).toContain('已被外部修改')
    expect(snapshot.notice).toBeNull()
    // 重试清掉旧错误。
    mocks.applyWebConfig.mockResolvedValue(undefined)
    await store.apply()
    expect(store.getSnapshot().applyError).toBeNull()
  })

  it('视图缺席（未就绪）时 apply 为无操作', async () => {
    const store = new EndpointStore(t)
    await store.apply()
    expect(mocks.applyWebConfig).not.toHaveBeenCalled()
  })
})

describe('projectEndpoint', () => {
  it('监听中且凭据已配置：地址原样展示，状态行不出声', () => {
    const display = projectEndpoint(t, listeningView())
    expect(display.urlText).toBe(listeningView().baseUrl)
    expect(display.statusText).toBeNull()
    expect(display.credentialHint).toBeNull()
  })

  it('未监听或凭据缺失：状态行给出异常事实与候选引用名', () => {
    const down = projectEndpoint(t, view({ baseUrl: null, port: null }))
    expect(down.statusText).toBe('未监听 · 凭据已配置')
    const missing = projectEndpoint(t, view({ credential: { configured: false, failure: undefined } }))
    expect(missing.statusText).toBe('已监听 · 凭据未配置（ZAI_CODING_CN_API_KEY / ZAI_API_KEY）')
  })

  it('凭据解析故障原文透传', () => {
    const display = projectEndpoint(
      t,
      view({ credential: { configured: false, failure: '凭证解析失败（ZAI_CODING_CN_API_KEY: 存储被锁）' } }),
    )
    expect(display.statusText).toContain('凭据未配置')
    expect(display.credentialHint).toContain('存储被锁')
  })
})
