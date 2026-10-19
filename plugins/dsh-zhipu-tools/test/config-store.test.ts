/** 接入面板 store 与投影：刷新、写入流程与凭据文案。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusView } from '../src/shared'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  applyWebConfig: vi.fn(),
}))

vi.mock('../src/client/api', () => ({
  configApi: { status: mocks.status, applyWebConfig: mocks.applyWebConfig },
}))

import { ConfigStore } from '../src/client/store'
import { projectConfig } from '../src/client/view'
import { makeT } from './i18n'

const t = makeT()

const view = (overrides: Partial<StatusView> = {}): StatusView => ({
  credential: { configured: true, failure: undefined },
  ...overrides,
})

const readyView = (): StatusView => view()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockResolvedValue(readyView())
  mocks.applyWebConfig.mockResolvedValue(undefined)
})

describe('ConfigStore', () => {
  it('刷新写入视图，错误进入 error 态', async () => {
    const store = new ConfigStore(t)
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', view: readyView() })
    mocks.status.mockRejectedValue(new Error('宿主离线'))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: '宿主离线' })
  })

  it('apply 成功：无参发起请求，Toast 提示，不再额外刷新', async () => {
    const store = new ConfigStore(t)
    await store.refresh()
    await store.apply()
    expect(mocks.applyWebConfig).toHaveBeenCalledWith()
    expect(store.getSnapshot().notice).toContain('写入')
    expect(store.getSnapshot().applyError).toBeNull()
    expect(mocks.status).toHaveBeenCalledTimes(1)
  })

  it('apply 失败：原文留在按钮旁错误行，不出 Toast', async () => {
    const store = new ConfigStore(t)
    await store.refresh()
    mocks.applyWebConfig.mockRejectedValue(
      new Error('Configuration for "web-deepseek-api" is overridden by a home patch or command-line overlay'),
    )
    await store.apply()
    const snapshot = store.getSnapshot()
    expect(snapshot.applyError).toContain('overridden by a home patch')
    expect(snapshot.notice).toBeNull()
    // 重试清掉旧错误。
    mocks.applyWebConfig.mockResolvedValue(undefined)
    await store.apply()
    expect(store.getSnapshot().applyError).toBeNull()
  })

  it('视图缺席（未就绪）时 apply 为无操作', async () => {
    const store = new ConfigStore(t)
    await store.apply()
    expect(mocks.applyWebConfig).not.toHaveBeenCalled()
  })
})

describe('projectConfig', () => {
  it('凭据在场：状态值已配置，无故障提示', () => {
    const display = projectConfig(t, readyView())
    expect(display.credentialText).toBe('已配置')
    expect(display.credentialHint).toBeNull()
  })

  it('凭据缺席：值给出候选引用名', () => {
    const display = projectConfig(t, view({ credential: { configured: false, failure: undefined } }))
    expect(display.credentialText).toBe('未配置（ZAI_CODING_CN_API_KEY / ZAI_API_KEY）')
  })

  it('凭据解析故障原文透传', () => {
    const display = projectConfig(
      t,
      view({ credential: { configured: false, failure: '凭证解析失败（ZAI_CODING_CN_API_KEY: 存储被锁）' } }),
    )
    expect(display.credentialHint).toContain('存储被锁')
  })
})
