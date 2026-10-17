/** 端点面板 store 与投影：刷新、复制提示与状态文案。 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EndpointStatusView } from '../src/shared'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  writeText: vi.fn(),
}))

vi.mock('../src/client/api', () => ({
  endpointApi: { status: mocks.status },
}))

import { EndpointStore } from '../src/client/store'
import { projectEndpoint } from '../src/client/view'
import { makeT } from './i18n'

const t = makeT()

const view = (overrides: Partial<EndpointStatusView> = {}): EndpointStatusView => ({
  baseUrl: 'http://127.0.0.1:39617',
  port: 39617,
  token: 'ab'.repeat(16),
  failure: null,
  credential: { configured: true, failure: undefined },
  fetchBackend: 'zhipu-reader',
  mcp: [
    { server: 'zhipu_search', mounted: true },
    { server: 'zhipu_reader', mounted: true },
  ],
  ...overrides,
})

const listeningView = (): EndpointStatusView => view()

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { clipboard: { writeText: mocks.writeText } })
  mocks.status.mockResolvedValue(listeningView())
  mocks.writeText.mockResolvedValue(undefined)
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

  it('复制成功即显 Toast，失败原样留在错误行', async () => {
    const store = new EndpointStore(t)
    await store.refresh()
    await store.copyUrl()
    expect(mocks.writeText).toHaveBeenCalledWith(listeningView().baseUrl)
    expect(store.getSnapshot().notice).toContain('端点地址')
    await store.copyToken()
    expect(mocks.writeText).toHaveBeenCalledWith(listeningView().token)
    expect(store.getSnapshot().notice).toContain('API 密钥')
    mocks.writeText.mockRejectedValue(new Error('剪贴板被占用'))
    await store.copyUrl()
    expect(store.getSnapshot().notice).toBeNull()
    expect(store.getSnapshot().error).toContain('剪贴板被占用')
  })

  it('视图缺席（未就绪）时复制为无操作', async () => {
    const store = new EndpointStore(t)
    await store.copyUrl()
    await store.copyToken()
    expect(mocks.writeText).not.toHaveBeenCalled()
    expect(store.getSnapshot().notice).toBeNull()
  })
})

describe('projectEndpoint', () => {
  it('监听中：地址与密钥原样展示、状态带端口、凭据与 MCP 齐备', () => {
    const display = projectEndpoint(t, listeningView())
    expect(display.urlText).toBe(listeningView().baseUrl)
    expect(display.tokenText).toBe(listeningView().token)
    expect(display.listenText).toBe('已监听 127.0.0.1:39617')
    expect(display.credentialText).toBe('已配置')
    expect(display.credentialHint).toBeNull()
    expect(display.mcpText).toBe('zhipu_search ✓　zhipu_reader ✓')
  })

  it('未监听：地址与密钥落空，凭据缺失给出候选引用名', () => {
    const display = projectEndpoint(
      t,
      view({
        baseUrl: null,
        port: null,
        token: null,
        credential: { configured: false, failure: '凭证解析失败（ZAI_CODING_CN_API_KEY: 存储被锁）' },
      }),
    )
    expect(display.urlText).toBeNull()
    expect(display.tokenText).toBeNull()
    expect(display.listenText).toBe('未监听')
    expect(display.credentialText).toContain('ZAI_CODING_CN_API_KEY')
    expect(display.credentialHint).toContain('存储被锁')
  })
})
