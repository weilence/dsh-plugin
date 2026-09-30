import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SearchSwitchView } from '../src/shared'

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  set: vi.fn(),
}))

vi.mock('../src/client/api', () => ({
  switchApi: { state: mocks.state, set: mocks.set },
}))

import { SearchSwitchStore } from '../src/client/store'
import { projectSwitch } from '../src/client/view'

const view = (overrides: Partial<SearchSwitchView> = {}): SearchSwitchView => ({
  effectiveProvider: 'deepseek-official',
  active: false,
  fileProvider: null,
  editable: true,
  reason: null,
  hotApply: true,
  patchPaths: { profile: '/p/cordis.patch.yml', home: '/h/cordis.patch.yml' },
  writeTarget: 'create:home',
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.mockResolvedValue(view())
  mocks.set.mockResolvedValue({ enabled: true, scope: 'home', written: true })
})

describe('SearchSwitchStore', () => {
  it('刷新写入视图，错误进入 error 态', async () => {
    const store = new SearchSwitchStore()
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'ready', view: view() })
    mocks.state.mockRejectedValue(new Error('宿主离线'))
    await store.refresh()
    expect(store.getSnapshot()).toMatchObject({ status: 'error', error: '宿主离线' })
  })

  it('写入成功后立即显示目标值，宿主追上时结算等待态', async () => {
    const store = new SearchSwitchStore()
    await store.refresh()
    mocks.state.mockResolvedValue(view({ fileProvider: 'zhipu' }))
    await store.setEnabled(true)
    expect(mocks.set).toHaveBeenCalledWith({ enabled: true })
    // 文件已写、运行时未跟上：显示目标值并保持等待。
    expect(store.getSnapshot()).toMatchObject({ pending: true, notice: expect.stringContaining('home 层') })
    // 运行时追上：等待态结算。
    mocks.state.mockResolvedValue(view({ active: true, fileProvider: 'zhipu', effectiveProvider: 'zhipu' }))
    await store.refresh()
    expect(store.getSnapshot().pending).toBeNull()
  })

  it('写入失败显示错误且不进入等待态', async () => {
    const store = new SearchSwitchStore()
    await store.refresh()
    mocks.set.mockRejectedValue(new Error('web 配置由启动参数 --patch 指定'))
    await expect(store.setEnabled(true)).resolves.toBe(false)
    expect(store.getSnapshot()).toMatchObject({ error: expect.stringContaining('--patch'), pending: null })
  })

  it('未写入（幂等）时提示已处于目标态', async () => {
    const store = new SearchSwitchStore()
    await store.refresh()
    mocks.set.mockResolvedValue({ enabled: true, scope: 'home', written: false })
    await store.setEnabled(true)
    expect(store.getSnapshot().notice).toContain('已处于开启状态')
  })
})

describe('projectSwitch', () => {
  it('默认关闭态：显示生效提供者与在线生效方式', () => {
    const display = projectSwitch(view(), null, false)
    expect(display).toMatchObject({
      checked: false,
      disabled: false,
      waiting: false,
      providerText: 'deepseek-official',
      effectText: '修改可在线生效',
    })
    expect(display.hint).toBeNull()
  })

  it('启动参数来源：开关禁用并给原因', () => {
    const display = projectSwitch(
      view({ editable: false, reason: 'web 配置由启动参数 --patch 指定' }),
      null,
      false,
    )
    expect(display.disabled).toBe(true)
    expect(display.switchTitle).toContain('--patch')
    expect(display.hint).toContain('--patch')
  })

  it('等待生效：显示等待并按宿主能力给出恢复预期', () => {
    const online = projectSwitch(view({ hotApply: true }), true, false)
    expect(online).toMatchObject({ checked: true, waiting: true })
    expect(online.hint).toContain('重新组装')
    const offline = projectSwitch(view({ hotApply: false }), true, false)
    expect(offline.hint).toContain('重启')
    expect(offline.effectText).toBe('等待宿主应用…')
  })

  it('已替换且可编辑：提示卸载前先关闭', () => {
    const display = projectSwitch(view({ active: true, effectiveProvider: 'zhipu' }), null, false)
    expect(display.checked).toBe(true)
    expect(display.hint).toContain('卸载')
  })

  it('内省不可用：来源标注为文件推算', () => {
    const display = projectSwitch(
      view({ effectiveProvider: undefined, fileProvider: 'zhipu', active: true }),
      null,
      false,
    )
    expect(display.providerText).toBe('zhipu')
    expect(display.sourceText).toContain('文件推算')
  })

  it('写入中禁用开关', () => {
    expect(projectSwitch(view(), null, true).disabled).toBe(true)
  })
})
