/** 接入面板 store 与投影：刷新、开关流程与凭据文案。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StatusView } from '../src/shared'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  setWebConfig: vi.fn(),
}))

vi.mock('../src/client/api', () => ({
  configApi: { status: mocks.status, setWebConfig: mocks.setWebConfig },
}))

import { ConfigStore } from '../src/client/store'
import { projectConfig } from '../src/client/view'
import { makeT } from './i18n'

const t = makeT()

const view = (overrides: Partial<StatusView> = {}): StatusView => ({
  credential: { configured: true, failure: undefined },
  enabled: false,
  ...overrides,
})

const readyView = (): StatusView => view()

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockResolvedValue(readyView())
  mocks.setWebConfig.mockImplementation(async (body: { enabled: boolean }) => view({ enabled: body.enabled }))
})

describe('ConfigStore', () => {
  it('刷新写入视图，错误进入 error 态', async () => {
    const store = new ConfigStore()
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', view: readyView() })
    mocks.status.mockRejectedValue(new Error('宿主离线'))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: '宿主离线' })
  })

  it('toggle 开启成功：发送 enabled，以响应视图为准，不弹提示', async () => {
    const store = new ConfigStore()
    await store.refresh()
    await store.toggle(true)
    expect(mocks.setWebConfig).toHaveBeenCalledWith({ enabled: true })
    const snapshot = store.getSnapshot()
    expect(snapshot.view?.enabled).toBe(true)
    expect(snapshot.toggleError).toBeNull()
    expect(snapshot.pending).toBe(false)
  })

  it('toggle 失败：原文留在开关旁错误行，视图保持原状态', async () => {
    const store = new ConfigStore()
    await store.refresh()
    mocks.setWebConfig.mockRejectedValue(new Error('智谱凭据未配置（ZAI_CODING_CN_API_KEY），无法开启'))
    await store.toggle(true)
    const snapshot = store.getSnapshot()
    expect(snapshot.toggleError).toContain('无法开启')
    expect(snapshot.view?.enabled).toBe(false)
    expect(snapshot.pending).toBe(false)
    // 重试成功清掉旧错误。
    mocks.setWebConfig.mockResolvedValue(view({ enabled: true }))
    await store.toggle(true)
    expect(store.getSnapshot().toggleError).toBeNull()
  })

  it('视图缺席（未就绪）或写入进行中时 toggle 为无操作', async () => {
    const idle = new ConfigStore()
    await idle.toggle(true)
    expect(mocks.setWebConfig).not.toHaveBeenCalled()

    const store = new ConfigStore()
    await store.refresh()
    let release: () => void = () => {}
    mocks.setWebConfig.mockReturnValue(
      new Promise<StatusView>((resolve) => {
        release = () => resolve(view({ enabled: true }))
      }),
    )
    const first = store.toggle(true)
    await store.toggle(true)
    expect(mocks.setWebConfig).toHaveBeenCalledTimes(1)
    release()
    await first
    expect(store.getSnapshot().pending).toBe(false)
  })
})

describe('projectConfig', () => {
  it('凭据在场：正常不出声，无徽标与故障行', () => {
    const display = projectConfig(t, readyView())
    expect(display.credentialBadge).toBeNull()
    expect(display.credentialTitle).toBeNull()
    expect(display.failureText).toBeNull()
  })

  it('凭据缺席：warn 徽标，悬停说明给引用名', () => {
    const display = projectConfig(t, view({ credential: { configured: false, failure: undefined } }))
    expect(display.credentialBadge).toEqual({ text: '未配置', tone: 'warn' })
    expect(display.credentialTitle).toBe('未配置（ZAI_CODING_CN_API_KEY / ZAI_API_KEY）')
    expect(display.failureText).toBeNull()
  })

  it('凭据解析故障：徽标按未配置展示，悬停与错误行都透传原文', () => {
    const display = projectConfig(
      t,
      view({ credential: { configured: false, failure: '凭证解析失败（ZAI_CODING_CN_API_KEY: 存储被锁）' } }),
    )
    expect(display.credentialBadge).toEqual({ text: '未配置', tone: 'warn' })
    expect(display.credentialTitle).toContain('存储被锁')
    expect(display.failureText).toContain('存储被锁')
  })
})
