import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RemoteSection } from '../src/client/RemoteSection'
import { RemoteStore } from '../src/client/store'
import type { ConnRow, LocalRowsResponse, StateResponse } from '../src/shared'
import { makeT } from './i18n'

// 面板结构断言用最小替身：官方按钮 / Toast 只透出文本，共享组件透出关键字段。
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  Toast: ({ text }: { text: string }) => <div>{text}</div>,
  StateDot: ({ state }: { state: string }) => <span data-state-dot={state} />,
  MenuSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useAnchoredPosition: () => null,
}))

vi.mock('@dsh-plugins/client-ui', () => ({
  Panel: ({ title, children }: { title: string; children?: ReactNode }) => (
    <section>
      <h1>{title}</h1>
      {children}
    </section>
  ),
  CardList: ({
    items,
    renderCard,
    empty,
    after,
  }: {
    items: readonly ConnRow[]
    renderCard: (row: ConnRow) => {
      title: string
      note?: string
      pills?: { text: string }[]
      badge?: ReactNode
      actions?: ReactNode
      children?: ReactNode
      error?: string
      errorDetail?: { text: string; expandLabel: string }
    }
    empty?: ReactNode
    after?: ReactNode
  }) => (
    <div>
      {items.map((row) => {
        const card = renderCard(row)
        return (
          <div key={row.id}>
            <span>{card.title}</span>
            {card.pills?.map((pill, index) => (
              <span key={index}>{pill.text}</span>
            ))}
            {card.badge}
            {card.note !== undefined ? <span>{card.note}</span> : null}
            {card.error !== undefined ? <span>{card.error}</span> : null}
            {card.errorDetail !== undefined ? (
              <span>
                {card.errorDetail.expandLabel}|{card.errorDetail.text}
              </span>
            ) : null}
            {card.actions}
            {card.children}
          </div>
        )
      })}
      {empty}
      {after}
    </div>
  ),
  MenuButton: ({ label, items }: { label: string; items: readonly { label: string }[] }) => (
    <div>
      {label}|{items.map((item) => item.label).join(',')}
    </div>
  ),
  Dialog: ({
    title,
    description,
    actions,
    children,
  }: {
    title: string
    description?: string
    actions?: ReactNode
    children?: ReactNode
  }) => (
    <div>
      {title}
      {description}
      {children}
      {actions}
    </div>
  ),
  ConfirmDialog: ({
    title,
    body,
    confirmLabel,
    cancelLabel,
  }: {
    title: string
    body: string
    confirmLabel: string
    cancelLabel: string
  }) => (
    <div>
      {title}|{body}|{confirmLabel}|{cancelLabel}
    </div>
  ),
  TextField: ({ label }: { label: string }) => <label>{label}</label>,
  IssueList: () => null,
  PickList: () => null,
  SelectField: () => null,
  useWideSettingsDialog: () => undefined,
}))

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

function connRow(state: Partial<ConnRow['state']> = {}): ConnRow {
  return {
    id: 'dev',
    label: '开发机 A',
    sshAlias: 'dev-box',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
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

function stateResponse(env: { ssh?: boolean; tar?: boolean }, connections: ConnRow[]): StateResponse {
  return {
    env: { profileName: 'default', home: '/home', ssh: env.ssh ?? true, tar: env.tar ?? true },
    connections,
  }
}

function localRowsFixture(): LocalRowsResponse {
  return {
    available: true,
    skillRows: [],
    mcpRows: [],
    pluginRows: [],
    promptRow: { path: '/home/AGENTS.md', digest: null },
  }
}

function renderPanel(store: RemoteStore): string {
  return renderToStaticMarkup(createElement(RemoteSection, { store, t: makeT(), close: () => {} }))
}

/** SSR 不跑 effect（startPolling / loadLocalRows 都不发生），先经 refresh 灌入状态。 */
async function loadedStore(): Promise<RemoteStore> {
  const store = new RemoteStore()
  await store.refresh()
  return store
}

describe('远程开发面板渲染', () => {
  it('运行中的连接卡片展示阶段 pill、常驻动作与同步菜单', async () => {
    api.state.mockReturnValue(
      stateResponse({}, [
        connRow({
          phase: 'running',
          running: {
            url: 'http://127.0.0.1:18731',
            localPort: 18731,
            remotePort: 18730,
            pid: 42,
            since: '2026-01-01T00:00:00.000Z',
          },
          lastSync: {
            skills: { at: '2026-01-02T03:04:05.000Z', pushed: 2 },
            mcp: null,
            plugins: null,
            prompts: null,
          },
        }),
      ]),
    )
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    expect(html).toContain('<h1>远程开发</h1>')
    expect(html).toContain('新建连接')
    expect(html).toContain('刷新')
    expect(html).toContain('运行中')
    expect(html).toContain('打开')
    // 无断开操作：运行中动作只有「打开」
    expect(html).not.toContain('断开')
    expect(html).toContain('同步 ▾|同步 Skills,同步 MCP,同步插件,同步提示词')
    expect(html).toContain('远端 profile web（固定） · 端口 18731 → 18730')
    expect(html).toContain('上次 Skills 同步：推送 2（')
    expect(html).toContain('显示名')
    expect(html).toContain('SSH 别名')
    expect(html).toContain('取消')
    expect(html).toContain('保存')
    store.stopPolling()
  })

  it('空闲连接展示测试 / 连接动作，不显示端口与探针段', async () => {
    api.state.mockReturnValue(stateResponse({}, [connRow()]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    expect(html).toContain('空闲')
    expect(html).toContain('测试')
    expect(html).toContain('连接')
    expect(html).not.toContain('端口')
    expect(html).not.toContain('探针')
    store.stopPolling()
  })

  it('本机缺 ssh 时置顶阻断告警（tar 提示不叠加）', async () => {
    api.state.mockReturnValue(stateResponse({ ssh: false }, [connRow()]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    expect(html).toContain('本机未找到 ssh 可执行文件')
    expect(html).not.toContain('本机未找到 tar')
    store.stopPolling()
  })

  it('本机缺 tar 时提示 Skills 同步不可用', async () => {
    api.state.mockReturnValue(stateResponse({ tar: false }, [connRow()]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    expect(html).toContain('本机未找到 tar：Skills 同步不可用')
    store.stopPolling()
  })

  it('删除确认弹窗走 ConfirmDialog 新契约（确认 / 取消词由调用方传入）', async () => {
    const row = connRow()
    api.state.mockReturnValue(stateResponse({}, [row]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    store.askDelete(row)
    const html = renderPanel(store)

    expect(html).toContain('删除连接|')
    expect(html).toContain('确认删除「开发机 A」（dev-box）？只清除本机记录与端口转发')
    expect(html).toContain('|删除|取消')
    store.stopPolling()
  })

  it('未连接时点「同步插件」的引导弹窗展示连接确认文案', async () => {
    const row = connRow()
    api.state.mockReturnValue(stateResponse({}, [row]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    store.askConnect(row)
    const html = renderPanel(store)

    expect(html).toContain('连接远端')
    expect(html).toContain('同步插件需要远端已连接。现在连接「开发机 A」（dev-box）？')
    store.stopPolling()
  })

  it('同步失败（连接仍在 running）：错误摘要行带 detail 时透出「查看完整」', async () => {
    api.state.mockReturnValue(
      stateResponse({}, [
        connRow({
          phase: 'running',
          running: {
            url: 'http://127.0.0.1:19999',
            localPort: 19999,
            remotePort: 19998,
            pid: 4242,
            since: '2026-01-01T00:00:00.000Z',
          },
          error: {
            message: '远端安装失败：ENOENT …',
            kind: 'remote-cmd-failed',
            detail: 'line-a\nline-b\nline-c',
          },
        }),
      ]),
    )
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    expect(html).toContain('远端安装失败：ENOENT …')
    expect(html).toContain('查看完整|line-a')
    expect(html).toContain('line-c')
    store.stopPolling()
  })

  it('操作进行中：文字进度 pill 让位 spinner（hover 浮层为交互态，SSR 不渲染）', async () => {
    api.state.mockReturnValue(
      stateResponse({}, [
        connRow({
          phase: 'deploying',
          op: { kind: 'connect' },
          progress: {
            kind: 'connect',
            steps: [
              { step: 'probe', detail: 'node / npm / pnpm / dsh', at: '2026-01-01T00:00:01.000Z' },
              { step: 'install-dsh', detail: '0.1.7-rc.2', at: '2026-01-01T00:00:02.000Z' },
            ],
          },
        }),
      ]),
    )
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    // 阶段文字 pill 不再出现（spinner 表进行中）；浮层只在 hover 后挂载
    expect(html).not.toContain('部署中')
    expect(html).toContain('data-state-dot="ongoing"')
    expect(html).not.toContain('probe · node / npm / pnpm / dsh')
    store.stopPolling()
  })

  it('连接失败：badge 显示「连接失败」，详情弹窗含错误摘要、时间线与全文', async () => {
    const row = connRow({
      phase: 'error',
      error: {
        message: '远端安装 @deepseek-ai/dsh 失败：ENOENT …',
        kind: 'remote-cmd-failed',
        detail: 'line-a\nline-b',
      },
      progress: {
        kind: 'connect',
        steps: [{ step: 'probe', detail: 'node / npm / pnpm / dsh', at: '2026-01-01T00:00:01.000Z' }],
      },
    })
    api.state.mockReturnValue(stateResponse({}, [row]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderPanel(store)

    // 失败入口在 badge 位；错误摘要行不出现（收敛进弹窗）
    expect(html).toContain('>连接失败</button>')
    expect(html).not.toContain('查看完整')
    expect(html).not.toContain('远端安装 @deepseek-ai/dsh 失败：ENOENT …')

    store.askFailedDetail(row)
    const dialog = renderPanel(store)
    expect(dialog).toContain('远端安装 @deepseek-ai/dsh 失败：ENOENT …')
    expect(dialog).toContain('操作过程')
    expect(dialog).toContain('probe · node / npm / pnpm / dsh')
    expect(dialog).toContain('line-a')
    expect(dialog).toContain('line-b')
    store.stopPolling()
  })

  it('面板文案随宿主语言整体切换', async () => {
    api.state.mockReturnValue(stateResponse({}, [connRow()]))
    api.localRows.mockReturnValue(localRowsFixture())
    const store = await loadedStore()
    const html = renderToStaticMarkup(
      createElement(RemoteSection, { store, t: makeT('en'), close: () => {} }),
    )
    expect(html).toContain('<h1>Remote development</h1>')
    expect(html).toContain('New connection')
    expect(html).not.toContain('新建连接')
    store.stopPolling()
  })
})
