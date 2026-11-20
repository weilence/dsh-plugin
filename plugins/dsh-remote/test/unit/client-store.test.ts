import { describe, expect, it, vi } from 'vitest'
import { RemoteStore } from '../../src/client/store'
import type { PanelMessage } from '../../src/client/locales'
import { messageText } from '../../src/client/locales'
import type { ConnRow, ConnectionTarget, StateResponse } from '../../src/shared'
import { makeT } from '../i18n'

// store 走 HTTP 封装取状态；这里换成可控的顺序桩（refresh 链路其余为真实逻辑）。
const api = vi.hoisted(() => ({
  state: vi.fn(),
  localRows: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  test: vi.fn(),
  sshHosts: vi.fn(),
  setSecret: vi.fn(),
  remoteInventory: vi.fn(),
  connect: vi.fn(),
  upgrade: vi.fn(),
  sync: vi.fn(),
}))

vi.mock('../../src/client/api', () => ({ remoteApi: api }))

/** 快照消息 → 展示文本（与常驻显示点渲染同一取词路径）。 */
const text = (message: PanelMessage | null): string | null =>
  message === null ? null : messageText(message, makeT())

/** 收集 store 投递的事件 toast（与壳层常驻显示点同一订阅路径）。 */
function collectToasts(store: RemoteStore): PanelMessage[] {
  const seen: PanelMessage[] = []
  store.toasts.subscribe((message) => seen.push(message))
  return seen
}

const PASSWORD_TARGET: ConnectionTarget = {
  kind: 'direct',
  host: '10.0.0.5',
  port: null,
  user: null,
  auth: 'password',
  identityFile: null,
}

function connRow(
  id: string,
  state: Partial<ConnRow['state']> = {},
  extra: Partial<Pick<ConnRow, 'target' | 'secretState' | 'rememberSecret'>> = {},
): ConnRow {
  return {
    id,
    label: `连接 ${id}`,
    target: { kind: 'alias', alias: 'dev-box' },
    secretState: 'none',
    rememberSecret: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
    state: {
      phase: 'idle',
      op: null,
      progress: null,
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
  it('用户发起的连接完成不发 toast（spinner 终态与阶段 pill 已是常驻反馈）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { phase: 'starting' })]))
    await store.refresh()
    expect(seen).toHaveLength(0)

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
            machine: { node: 'v22.19.0', npm: '10.8.2', dsh: '0.1.7-rc.2' },
            instance: { dsh: '0.1.7-rc.2', plugin: '0.1.0' },
            drift: null,
            localDsh: '0.1.7-rc.2',
            health: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(seen).toHaveLength(0)
    store.stopPolling()
  })

  it('recover op 的 starting → running 投递「已自动恢复」toast（用户没点过连接）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { phase: 'starting', op: { kind: 'recover' } })]),
    )
    await store.refresh()
    expect(seen).toHaveLength(0)

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
            machine: { node: 'v22.19.0', npm: '10.8.2', dsh: '0.1.7-rc.2' },
            instance: { dsh: '0.1.7-rc.2', plugin: '0.1.0' },
            drift: null,
            localDsh: '0.1.7-rc.2',
            health: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(seen[0] ?? null)).toBe('远端实例曾停止，已自动恢复「连接 dev」——点「打开」重新进入')
    store.stopPolling()
  })

  it('reconnect op 的 starting → running 投递「已自动重连」toast（隧道中断被重建）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { phase: 'starting', op: { kind: 'reconnect' } })]),
    )
    await store.refresh()
    expect(seen).toHaveLength(0)

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
            machine: { node: 'v22.19.0', npm: '10.8.2', dsh: '0.1.7-rc.2' },
            instance: { dsh: '0.1.7-rc.2', plugin: '0.1.0' },
            drift: null,
            localDsh: '0.1.7-rc.2',
            health: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(seen[0] ?? null)).toBe('「连接 dev」的隧道曾中断，已自动重连——点「打开」重新进入')
    store.stopPolling()
  })

  it('升级完成不发 toast（版本事实行已刷新为远端新版本）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { phase: 'starting', op: { kind: 'upgrade' } })]),
    )
    await store.refresh()

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
            machine: { node: 'v22.19.0', npm: '10.8.2', dsh: '0.2.0' },
            instance: { dsh: '0.2.0', plugin: '0.1.0' },
            drift: null,
            localDsh: '0.2.0',
            health: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(seen).toHaveLength(0)
    store.stopPolling()
  })

  it('同步 op 结束按类别投递完成摘要（处理量）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { phase: 'running', op: { kind: 'sync-skills' } })]),
    )
    await store.refresh()
    expect(seen).toHaveLength(0)

    api.state.mockResolvedValueOnce(
      stateResponse([
        connRow('dev', {
          phase: 'running',
          lastSync: {
            skills: { at: '2026-01-02T00:00:00.000Z', pushed: 2 },
            mcp: null,
            plugins: null,
            prompts: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(seen[0] ?? null)).toBe('同步 Skills 完成：推送 2')
    store.stopPolling()
  })

  it('同步插件完成摘要报安装数', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { op: { kind: 'sync-plugins' } })]))
    await store.refresh()
    api.state.mockResolvedValueOnce(
      stateResponse([
        connRow('dev', {
          lastSync: {
            skills: null,
            mcp: null,
            plugins: { at: '2026-01-02T00:00:00.000Z', installed: ['a'] },
            prompts: null,
          },
        }),
      ]),
    )
    await store.refresh()
    expect(text(seen[0] ?? null)).toBe('同步插件完成：安装 1')
    store.stopPolling()
  })

  it('同步失败时错误原文作为 detail 原样并入（不翻译外部事实）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { op: { kind: 'sync-mcp' } })]))
    await store.refresh()
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { error: { message: 'ssh: connect refused', kind: 'unreachable' } })]),
    )
    await store.refresh()
    expect(text(seen[0] ?? null)).toBe('同步 MCP 失败：ssh: connect refused')
    store.stopPolling()
  })

  it('lastSync 摘要缺失时退回类别的通用完成文案', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { op: { kind: 'sync-prompts' } })]))
    await store.refresh()
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev')]))
    await store.refresh()
    expect(text(seen[0] ?? null)).toBe('同步提示词完成')
    store.stopPolling()
  })
})

describe('RemoteStore 写操作不投递 toast（卡片增删即反馈）', () => {
  it('保存成功 / 失败都不投递 toast，错误走 text 原样', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValue(stateResponse([]))

    api.save.mockResolvedValueOnce({ id: 'a' })
    expect(
      await store.save({ label: 'a', target: { kind: 'alias', alias: 'box' }, rememberSecret: false }),
    ).toBe(true)
    expect(seen).toHaveLength(0)

    api.save.mockResolvedValueOnce({ id: 'a' })
    expect(
      await store.save({
        id: 'a',
        label: 'a2',
        target: { kind: 'alias', alias: 'box' },
        rememberSecret: false,
      }),
    ).toBe(true)
    expect(seen).toHaveLength(0)

    api.save.mockRejectedValueOnce(new Error('boom'))
    expect(
      await store.save({
        id: 'a',
        label: 'a3',
        target: { kind: 'alias', alias: 'box' },
        rememberSecret: false,
      }),
    ).toBe(false)
    expect(text(store.getSnapshot().error)).toBe('boom')
    store.stopPolling()
  })

  it('删除成功不投递 toast', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValue(stateResponse([]))
    api.remove.mockResolvedValueOnce({ removed: true })
    expect(await store.remove('a')).toBe(true)
    expect(seen).toHaveLength(0)
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

describe('RemoteStore 表单测试与口令弹窗', () => {
  it('测试结果落 testResult 行内（不发 toast，不写连接状态）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    const target: ConnectionTarget = { kind: 'alias', alias: 'dev-box' }
    const resultText = (): string | null => {
      const result = store.getSnapshot().testResult
      return result === null ? null : text(result.message)
    }

    api.test.mockResolvedValueOnce({
      ok: true,
      nodeVersion: 'v22.19.0',
      npmVersion: '10.8.2',
      dshVersion: '0.1.7-rc.2',
      error: null,
    })
    await store.testDraft({ target })
    expect(resultText()).toBe('测试通过：node v22.19.0，npm 10.8.2，dsh 0.1.7-rc.2')
    expect(seen).toHaveLength(0)
    expect(store.getSnapshot().testing).toBe(false)

    api.test.mockResolvedValueOnce({
      ok: true,
      nodeVersion: 'v22.19.0',
      npmVersion: '10.8.2',
      dshVersion: null,
      error: null,
    })
    await store.testDraft({ target })
    expect(resultText()).toBe('测试通过：node v22.19.0，npm 10.8.2，未安装 dsh')

    api.test.mockResolvedValueOnce({
      ok: false,
      nodeVersion: null,
      npmVersion: null,
      dshVersion: null,
      error: { message: 'Permission denied (publickey)', kind: 'auth-failed' },
    })
    await store.testDraft({ target })
    expect(resultText()).toBe('测试失败：Permission denied (publickey)')
    expect(store.getSnapshot().testResult?.ok).toBe(false)
    store.stopPolling()
  })

  it('密码连接缺口令时先弹补录框：补录只进内存，随后继续连接', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValue(
      stateResponse([connRow('dev', {}, { target: PASSWORD_TARGET, secretState: 'none' })]),
    )
    await store.refresh()

    await store.connect('dev')
    expect(store.getSnapshot().secretPrompt).toMatchObject({ id: 'dev', action: 'connect' })
    expect(api.connect).not.toHaveBeenCalled()

    api.setSecret.mockResolvedValueOnce({ ok: true })
    api.state.mockResolvedValue(
      stateResponse([connRow('dev', {}, { target: PASSWORD_TARGET, secretState: 'session' })]),
    )
    await store.submitSecret('pw')
    expect(api.setSecret).toHaveBeenCalledWith('dev', 'pw')
    expect(api.connect).toHaveBeenCalledWith('dev')
    expect(store.getSnapshot().secretPrompt).toBeNull()
  })

  it('同步入口同样先补口令，补完打开同步弹窗', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValue(
      stateResponse([connRow('dev', {}, { target: PASSWORD_TARGET, secretState: 'none' })]),
    )
    await store.refresh()
    store.askSync({ id: 'dev', kind: 'skills' })
    expect(store.getSnapshot().secretPrompt).toMatchObject({ action: 'sync', kind: 'skills' })
    expect(store.getSnapshot().syncing).toBeNull()

    api.setSecret.mockResolvedValueOnce({ ok: true })
    api.state.mockResolvedValue(
      stateResponse([connRow('dev', {}, { target: PASSWORD_TARGET, secretState: 'session' })]),
    )
    await store.submitSecret('pw')
    expect(store.getSnapshot().syncing).toEqual({ id: 'dev', kind: 'skills' })
  })

  it('升级入口同样先补口令，补完继续升级', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValue(
      stateResponse([connRow('dev', {}, { target: PASSWORD_TARGET, secretState: 'none' })]),
    )
    await store.refresh()

    await store.upgrade('dev')
    expect(store.getSnapshot().secretPrompt).toMatchObject({ id: 'dev', action: 'upgrade' })
    expect(api.upgrade).not.toHaveBeenCalled()

    api.setSecret.mockResolvedValueOnce({ ok: true })
    api.state.mockResolvedValue(
      stateResponse([connRow('dev', {}, { target: PASSWORD_TARGET, secretState: 'session' })]),
    )
    await store.submitSecret('pw')
    expect(api.upgrade).toHaveBeenCalledWith('dev')
    expect(store.getSnapshot().secretPrompt).toBeNull()
  })

  it('已有会话口令时不弹框；别名连接永远不弹', async () => {
    const store = new RemoteStore()
    api.state.mockResolvedValue(
      stateResponse([
        connRow('a', {}, { target: PASSWORD_TARGET, secretState: 'session' }),
        connRow('b', {}, { target: PASSWORD_TARGET, secretState: 'none' }),
      ]),
    )
    await store.refresh()
    await store.connect('a')
    expect(store.getSnapshot().secretPrompt).toBeNull()
    expect(api.connect).toHaveBeenCalledWith('a')

    api.state.mockResolvedValue(
      stateResponse([connRow('alias', {}, { target: { kind: 'alias', alias: 'box' } })]),
    )
    await store.refresh()
    await store.connect('alias')
    expect(store.getSnapshot().secretPrompt).toBeNull()
    store.stopPolling()
  })

  it('ssh config 清单懒加载：成功缓存、失败给 text 错误', async () => {
    const store = new RemoteStore()
    api.sshHosts.mockResolvedValueOnce({
      path: '/home/u/.ssh/config',
      exists: true,
      hosts: [
        { alias: 'box', hostname: '10.0.0.5', user: 'root', port: 22, identityFile: null, proxy: null },
      ],
      error: null,
    })
    await store.loadSshHosts()
    expect(store.getSnapshot().sshHosts?.hosts[0]?.alias).toBe('box')
    expect(store.getSnapshot().sshHostsLoading).toBe(false)

    api.sshHosts.mockRejectedValueOnce(new Error('denied'))
    await store.loadSshHosts()
    expect(text(store.getSnapshot().sshHostsError)).toBe('denied')
    store.stopPolling()
  })
})

describe('RemoteStore 面板关闭边界（一次性反馈不跨关闭窗口存活）', () => {
  const RUNNING = {
    url: 'http://127.0.0.1:18731',
    localPort: 18731,
    remotePort: 18730,
    pid: 42,
    since: '2026-01-01T00:00:00.000Z',
    machine: { node: 'v22.19.0', npm: '10.8.2', dsh: '0.1.7-rc.2' },
    instance: { dsh: '0.1.7-rc.2', plugin: '0.1.0' },
    drift: null,
    localDsh: '0.1.7-rc.2',
    health: null,
  }

  it('关闭期间完成的连接迁移是旧闻：重开面板首轮 refresh 不补发 toast', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    // 挂载期最后一轮看到 starting，随后面板关闭、连接在后台完成
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { phase: 'starting' })]))
    await store.refresh()
    store.stopPolling()

    // 重开面板（startPolling 首轮 refresh）：迁移记忆已随关闭清空，不投递 toast
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { phase: 'running', running: RUNNING })]))
    store.startPolling()
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'))
    expect(seen).toHaveLength(0)
    store.stopPolling()
  })

  it('关闭期间完成的同步不补发摘要（prevOps 同样只在观察窗口内有效）', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    api.state.mockResolvedValueOnce(
      stateResponse([connRow('dev', { phase: 'running', op: { kind: 'sync-skills' } })]),
    )
    await store.refresh()
    store.stopPolling()

    api.state.mockResolvedValueOnce(
      stateResponse([
        connRow('dev', {
          phase: 'running',
          lastSync: {
            skills: { at: '2026-01-02T00:00:00.000Z', pushed: 2 },
            mcp: null,
            plugins: null,
            prompts: null,
          },
        }),
      ]),
    )
    store.startPolling()
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'))
    expect(seen).toHaveLength(0)
    store.stopPolling()
  })

  it('关闭瞬间在途的 refresh 不记录迁移也不投递 toast', async () => {
    const store = new RemoteStore()
    const seen = collectToasts(store)
    let resolveState: (value: StateResponse) => void = () => {}
    api.state.mockReturnValueOnce(
      new Promise<StateResponse>((resolve) => {
        resolveState = resolve
      }),
    )
    const pending = store.refresh()
    // 关闭面板：在途请求随后才落地
    store.stopPolling()
    resolveState(stateResponse([connRow('dev', { phase: 'starting', op: { kind: 'connect' } })]))
    await pending
    expect(seen).toHaveLength(0)
    expect(store.getSnapshot().status).toBe('ready')

    // 在途 refresh 未留下迁移记忆：重开面板首轮看到 running 也不投递 toast
    api.state.mockResolvedValueOnce(stateResponse([connRow('dev', { phase: 'running', running: RUNNING })]))
    store.startPolling()
    await vi.waitFor(() => expect(store.getSnapshot().list?.connections[0]?.state.phase).toBe('running'))
    expect(seen).toHaveLength(0)
    store.stopPolling()
  })
})
