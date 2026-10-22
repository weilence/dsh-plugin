import { useSyncExternalStore, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ISessions,
  SessionListState,
  SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionsSection } from '../src/client'
import { PresetDialog } from '../src/client/preset'
import {
  createMigrateBridge,
  MigrateDialogEntry,
  MigrateMenuItem,
  type MigrateTarget,
} from '../src/client/migrate'
import {
  deleteSession,
  fetchPresets,
  migrateSessionPreset,
  migrateSessionToWorkspace,
  runBatch,
} from '../src/client/api'
import { en, zh } from '../src/client/locales'
import { SessionsStore } from '../src/client/store'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Button>) => <button {...props} />,
  Input: ({
    icon: _icon,
    ...props
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Input>) => <input {...props} />,
  IconSearchOutlineRegular: () => null,
  MenuItemButton: ({
    onSelect,
    separatorBefore: _separator,
    children,
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton>) => (
    <button role="menuitem" onClick={onSelect}>
      {children}
    </button>
  ),
  Modal: ({
    open,
    title,
    description,
    children,
    footer,
    closeLabel,
    onClose,
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Modal>) =>
    open ? (
      <section role="dialog">
        <h1>{title}</h1>
        <p>{description}</p>
        <button aria-label={closeLabel} onClick={onClose}>
          {closeLabel}
        </button>
        {children}
        {footer}
      </section>
    ) : null,
  Toast: ({ text }: { text: string }) => <div>{text}</div>,
}))
vi.mock('@dsh-plugins/client-ui', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  // 测试环境无 DOM；宽弹窗钩子只在真实浏览器挂类。
  useWideSettingsDialog: () => {},
}))
vi.mock('../src/client/api', () => ({
  importFiles: vi.fn(async () => {}),
  deleteSession: vi.fn(async () => ({ filesRemoved: true, archiveCleared: true, deletedSubagents: [] })),
  migrateSessionToWorkspace: vi.fn(async () => ({ ok: true, moved: true, attached: true })),
  fetchPresets: vi.fn(async () => ['coder', 'writer']),
  migrateSessionPreset: vi.fn(async () => ({ migrated: true, oldPreset: 'coder', newPreset: 'writer' })),
  runBatch: vi.fn(async () => ({ items: [] })),
}))

type SectionProps = ComponentProps<typeof SessionsSection>
const alpha = 'archive-alpha' as SessionId
const beta = 'archive-beta' as SessionId
const sub = 'sub-child' as SessionId
const blankSession = 'blank-session' as SessionId
const running = 'running-session' as SessionId

function workspaceSnapshot(overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot {
  return {
    phase: 'ready',
    state: 'idle',
    error: null,
    items: [
      {
        workspaceId: 'project' as never,
        title: 'Example workspace',
        path: '/project',
        sessionIds: [alpha],
        createdAt: '2027-01-01',
        updatedAt: '2027-01-01',
      },
    ],
    archivedSessionIds: [alpha],
    pinnedSessionIds: [],
    ...overrides,
  }
}

function summary(
  id: SessionId,
  displayTitle: string,
  cwd: string,
  overrides: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    id,
    displayTitle,
    cwd,
    running: false,
    blank: false,
    retainedBy: {},
    updatedAt: 1_800_000_000_000,
    ...overrides,
  }
}

function sessionSnapshot(overrides: Partial<SessionListState> = {}): SessionListState {
  return {
    phase: 'ready',
    ids: [alpha, beta, running, blankSession],
    byId: {
      [alpha]: summary(alpha, 'Alpha investigation', '/project/alpha-cwd', { updatedAt: 3_000 }),
      [beta]: summary(beta, 'Beta notes', '/other', { updatedAt: 1_000 }),
      [running]: summary(running, 'Running session', '/project', { running: true, updatedAt: 2_000 }),
      [blankSession]: summary(blankSession, 'Blank shell', '/project', { blank: true, updatedAt: 4_000 }),
      [sub]: summary(sub, 'Child worker', '/project', {
        origin: 'subagent',
        parentId: alpha,
        updatedAt: 500,
      }),
    },
    projectionsBySession: {},
    ...overrides,
  }
}

function source<T>(initial: T) {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(value: T, notify = true) {
      snapshot = value
      if (notify) listeners.forEach((listener) => listener())
    },
  }
}

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
  vi.clearAllMocks()
})

function mount(element: Parameters<typeof create>[0]) {
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(element)
  })
  renderers.push(renderer)
  return renderer
}

function section(
  workspace = workspaceSnapshot(),
  list = sessionSnapshot(),
  language: 'zh' | 'en' = 'zh',
  bridge = createMigrateBridge(),
) {
  const workspaceSource = source(workspace)
  const sessionSource = source(list)
  const archiveSession = vi.fn<IWorkspaces['archiveSession']>(async () => {})
  const unarchiveSession = vi.fn<IWorkspaces['unarchiveSession']>(async () => {})
  const refresh = vi.fn<ISessions['refresh']>(async () => {})
  const store = new SessionsStore(
    { list: workspaceSource, archiveSession, unarchiveSession } as unknown as IWorkspaces,
    refresh,
  )
  const useWorkspaces: SectionProps['useWorkspaces'] = (selector) =>
    selector(useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot))
  const useSessions: SectionProps['useSessions'] = (selector) =>
    selector(useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot))
  const props = {
    t: makeT(language),
    formatTime: (timestamp: number) => new Date(timestamp).toLocaleString(language),
    useWorkspaces,
    useSessions,
    sessions: { list: sessionSource, refresh } as unknown as ISessions,
    store,
    bridge,
  } as SectionProps
  const renderer = mount(<SessionsSection {...props} />)
  return {
    renderer,
    props,
    store,
    workspaceSource,
    sessionSource,
    archiveSession,
    unarchiveSession,
    refresh,
    bridge,
  }
}

const text = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node: ReactTestInstance) => typeof node.children[0] === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))

const setSelect = (renderer: ReactTestRenderer, optionIndex: number, value: string): void => {
  const select = renderer.root.findAllByType('select')[optionIndex]!
  act(() => {
    select.props.onChange({ target: { value } })
  })
}

const setSearch = (renderer: ReactTestRenderer, value: string): void => {
  const input = renderer.root.find(
    (node: ReactTestInstance) => node.type === 'input' && node.props.type !== 'checkbox',
  )
  act(() => {
    input.props.onChange({ target: { value } })
  })
}

const clickButton = (renderer: ReactTestRenderer, label: string): void => {
  const button = renderer.root
    .findAll((node: ReactTestInstance) => node.type === 'button' && node.children.includes(label))
    .find(Boolean)!
  act(() => {
    button.props.onClick()
  })
}

const rowOf = (renderer: ReactTestRenderer, titleFragment: string): ReactTestInstance =>
  renderer.root
    .findAllByType('li')
    .find((node) =>
      node
        .findAll((child) => child.type === 'strong')
        .some((strong) => String(strong.children[0]).includes(titleFragment)),
    )!

const rowButtons = (row: ReactTestInstance): Array<{ label: string; disabled: unknown }> =>
  row
    .findAll((node: ReactTestInstance) => node.type === 'button')
    .map((node) => ({ label: String(node.children[0]), disabled: node.props.disabled }))

describe('会话面板列表', () => {
  it('渲染全部会话与徽标：子会话与空白默认隐藏，归档与运行中可见', () => {
    const { renderer } = section()
    const content = text(renderer)
    expect(content.some((value) => value.includes('Alpha investigation'))).toBe(true)
    expect(content.some((value) => value.includes('Beta notes'))).toBe(true)
    expect(content.some((value) => value.includes('Running session'))).toBe(true)
    expect(content.some((value) => value.includes('已归档'))).toBe(true)
    expect(content.some((value) => value.includes('运行中'))).toBe(true)
    expect(content.some((value) => value.includes('Child worker'))).toBe(false)
    expect(content.some((value) => value.includes('Blank shell'))).toBe(false)
  })

  it('默认排序为最近更新在前，可切换最早更新与标题排序', () => {
    const { renderer } = section()
    const titles = () =>
      renderer.root
        .findAll((node: ReactTestInstance) => node.type === 'strong')
        .map((node) => String(node.children[0]))
    expect(titles()).toEqual(['Alpha investigation', 'Running session', 'Beta notes'])
    setSelect(renderer, 2, 'updated-asc')
    expect(titles()).toEqual(['Beta notes', 'Running session', 'Alpha investigation'])
    setSelect(renderer, 2, 'title-asc')
    expect(titles()[0]).toBe('Alpha investigation')
  })

  it('搜索匹配标题、会话 ID、cwd 与工作区路径', () => {
    const { renderer } = section()
    setSearch(renderer, 'alpha investigation')
    expect(text(renderer).some((value) => value.includes('Beta notes'))).toBe(false)
    setSearch(renderer, 'archive-beta')
    expect(text(renderer).some((value) => value.includes('Beta notes'))).toBe(true)
    setSearch(renderer, '/other')
    expect(text(renderer).some((value) => value.includes('Beta notes'))).toBe(true)
    setSearch(renderer, '/project')
    expect(text(renderer).some((value) => value.includes('Alpha investigation'))).toBe(true)
    setSearch(renderer, '不存在的关键词')
    expect(text(renderer).some((value) => value.includes('没有匹配条件的会话'))).toBe(true)
  })

  it('工作区过滤：未分组与指定工作区', () => {
    const { renderer } = section()
    setSelect(renderer, 0, 'ungrouped')
    expect(text(renderer).some((value) => value.includes('Alpha investigation'))).toBe(false)
    expect(text(renderer).some((value) => value.includes('Beta notes'))).toBe(true)
    setSelect(renderer, 0, 'project')
    expect(text(renderer).some((value) => value.includes('Beta notes'))).toBe(false)
    expect(text(renderer).some((value) => value.includes('Alpha investigation'))).toBe(true)
  })

  it('状态过滤与显示子会话、运行中、空白开关', () => {
    const { renderer } = section()
    setSelect(renderer, 1, 'active')
    expect(text(renderer).some((value) => value.includes('Alpha investigation'))).toBe(false)
    setSelect(renderer, 1, 'archived')
    expect(text(renderer).some((value) => value.includes('Beta notes'))).toBe(false)
    expect(text(renderer).some((value) => value.includes('Alpha investigation'))).toBe(true)
    setSelect(renderer, 1, 'all')
    const checkboxes = renderer.root.findAllByType('input').filter((node) => node.props.type === 'checkbox')
    act(() => {
      checkboxes[0]!.props.onChange({ target: { checked: true } })
      checkboxes[2]!.props.onChange({ target: { checked: true } })
    })
    const content = text(renderer)
    expect(content.some((value) => value.includes('Child worker'))).toBe(true)
    expect(content.some((value) => value.includes('Blank shell'))).toBe(true)
  })

  it('运行中的会话禁用删除，subagent 禁用迁移与预设入口', () => {
    const { renderer } = section()
    expect(
      rowButtons(rowOf(renderer, 'Running session')).find((button) => button.label === '删除')?.disabled,
    ).toBe(true)
    expect(
      rowButtons(rowOf(renderer, 'Beta notes')).find((button) => button.label === '删除')?.disabled,
    ).toBe(false)
  })
})

describe('行操作编排', () => {
  it('归档走官方命令并提示', async () => {
    const { renderer, archiveSession } = section()
    await act(async () => {
      clickButton(renderer, '归档')
    })
    expect(archiveSession).toHaveBeenCalledOnce()
  })

  it('删除经确认弹窗触发级联结果提示并刷新列表', async () => {
    vi.mocked(deleteSession).mockResolvedValueOnce({
      filesRemoved: true,
      archiveCleared: true,
      deletedSubagents: ['child-1'],
    })
    const { renderer, refresh } = section()
    clickButton(renderer, '删除')
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    expect(
      dialog.findAll((node: ReactTestInstance) => node.type === 'h1').map((node) => String(node.children[0])),
    ).toContain('删除会话')
    await act(async () => {
      dialog
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.children.includes('删除'))
        .forEach((node) => node.props.onClick())
    })
    expect(deleteSession).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    expect(
      text(renderer).some((value) => value.includes('已删除「Alpha investigation」及其 1 个子会话')),
    ).toBe(true)
  })

  it('删除失败经 notice 横幅提示实际原因', async () => {
    vi.mocked(deleteSession).mockRejectedValueOnce(new Error('写锁占用异常'))
    const { renderer } = section()
    clickButton(renderer, '删除')
    const dialog = renderer.root.findByProps({ role: 'dialog' })
    await act(async () => {
      dialog
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.children.includes('删除'))
        .forEach((node) => node.props.onClick())
    })
    expect(text(renderer).some((value) => value.includes('写锁占用异常'))).toBe(true)
  })

  it('迁移入口经桥打开弹窗，预设入口打开预设弹窗', () => {
    const bridge = createMigrateBridge()
    const { renderer } = section(workspaceSnapshot(), sessionSnapshot(), 'zh', bridge)
    clickButton(renderer, '迁移到工作区…')
    expect(bridge.get()).toMatchObject({ sessionId: expect.any(String) })
    clickButton(renderer, '迁移预设…')
    expect(renderer.root.findAllByProps({ role: 'dialog' }).length).toBe(1)
  })
})

describe('迁移与预设弹窗', () => {
  function migrateHarness() {
    const bridge = createMigrateBridge()
    bridge.open({ sessionId: alpha, title: 'Alpha investigation' })
    const workspaceSource = source(workspaceSnapshot())
    const useWorkspaceList = () =>
      useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot)
    const refresh = vi.fn(async () => {})
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(
        <MigrateDialogEntry
          {...({
            t: makeT('zh'),
            bridge,
            useWorkspaceList,
            refreshSessions: refresh,
          } as unknown as ComponentProps<typeof MigrateDialogEntry>)}
        />,
      )
    })
    renderers.push(renderer)
    return { renderer, bridge, refresh, workspaceSource }
  }

  it('菜单条目经桥发起请求并关闭菜单', () => {
    const bridge = createMigrateBridge()
    const setMenuOpen = vi.fn()
    const renderer = mount(
      <MigrateMenuItem
        {...({
          t: makeT('zh'),
          sessionId: alpha,
          displayTitle: 'Alpha',
          useMenuOpenState: () => [false, setMenuOpen],
          requestMigrate: (target: MigrateTarget) => bridge.open(target),
        } as unknown as ComponentProps<typeof MigrateMenuItem>)}
      />,
    )
    act(() => {
      renderer.root
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.props.role === 'menuitem')
        .forEach((node) => node.props.onClick())
    })
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(bridge.get()).toEqual({ sessionId: alpha, title: 'Alpha' })
  })

  it('选择工作区提交迁移，归属未完成时提示补救指引', async () => {
    vi.mocked(migrateSessionToWorkspace).mockResolvedValueOnce({
      ok: true,
      moved: true,
      attached: false,
      membershipPending: '已迁移文件，但归入目标工作区失败。请重启宿主后再次迁移',
    })
    const { renderer, refresh } = migrateHarness()
    const select = renderer.root.findByType('select')
    act(() => {
      select.props.onChange({ target: { value: 'project' } })
    })
    await act(async () => {
      clickButton(renderer, '迁移')
    })
    expect(migrateSessionToWorkspace).toHaveBeenCalledExactlyOnceWith(String(alpha), 'project')
    expect(refresh).toHaveBeenCalledOnce()
    expect(text(renderer).some((value) => value.includes('请重启宿主后再次迁移'))).toBe(true)
  })

  it('预设弹窗拉取清单后提交迁移', async () => {
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        <PresetDialog t={makeT('zh')} target={{ sessionId: alpha, title: 'Alpha' }} onClose={() => {}} />,
      )
    })
    renderers.push(renderer)
    await act(async () => {})
    expect(fetchPresets).toHaveBeenCalledOnce()
    const options = renderer.root.findAllByType('option').map((node) => String(node.props.value))
    expect(options).toContain('coder')
    await act(async () => {
      renderer.root.findByType('select').props.onChange({ target: { value: 'writer' } })
    })
    await act(async () => {
      clickButton(renderer, '迁移')
    })
    expect(migrateSessionPreset).toHaveBeenCalledExactlyOnceWith(String(alpha), 'writer')
    expect(text(renderer).some((value) => value.includes('writer'))).toBe(true)
  })
})

describe('批量操作', () => {
  const enterBatch = (renderer: ReactTestRenderer): void => {
    clickButton(renderer, '批量操作')
  }
  const rowCheckbox = (row: ReactTestInstance): ReactTestInstance => row.findByProps({ type: 'checkbox' })

  it('进出批量模式：复选框出现、行操作隐藏，退出清空选择', () => {
    const { renderer, store } = section()
    expect(renderer.root.findAllByType('li').some((row) => row.findAllByType('input').length > 0)).toBe(false)
    enterBatch(renderer)
    const rows = renderer.root.findAllByType('li')
    expect(rows.every((row) => row.findAllByProps({ type: 'checkbox' }).length === 1)).toBe(true)
    expect(text(renderer).some((value) => value.includes('归档'))).toBe(true)
    act(() => {
      rowCheckbox(rows[0]!).props.onChange()
    })
    expect(store.getSnapshot().batch.selection).toHaveLength(1)
    clickButton(renderer, '退出批量')
    expect(store.getSnapshot().batch.active).toBe(false)
    expect(store.getSnapshot().batch.selection).toHaveLength(0)
  })

  it('选中本筛选结果取当前可见行，跨过滤保留选择', () => {
    const { renderer, store } = section()
    enterBatch(renderer)
    clickButton(renderer, '选中本筛选结果')
    expect(store.getSnapshot().batch.selection).toHaveLength(3)
    setSelect(renderer, 0, 'project')
    // 切换过滤不清空选择：已选的未分组会话仍保留。
    expect(store.getSnapshot().batch.selection).toHaveLength(3)
    clickButton(renderer, '清除选择')
    expect(store.getSnapshot().batch.selection).toHaveLength(0)
  })

  it('批量归档循环官方命令并弹出结果', async () => {
    const { renderer, archiveSession } = section()
    enterBatch(renderer)
    clickButton(renderer, '选中本筛选结果')
    await act(async () => {
      clickButton(renderer, '归档')
    })
    expect(archiveSession).toHaveBeenCalledTimes(3)
    const dialog = renderer.root.findAllByProps({ role: 'dialog' })[0]
    expect(
      dialog.findAll((node: ReactTestInstance) => node.type === 'h1').map((node) => String(node.children[0])),
    ).toContain('批量结果')
    expect(text(renderer).some((value) => value.includes('批量完成：成功 3，失败 0'))).toBe(true)
  })

  it('批量删除经预览确认后提交并呈现级联摘要，失败项可重试', async () => {
    vi.mocked(runBatch)
      .mockResolvedValueOnce({
        items: [
          {
            sessionId: String(alpha),
            ok: true,
            result: { filesRemoved: true, archiveCleared: true, deletedSubagents: ['child-1'] },
          },
          { sessionId: String(beta), ok: false, error: '会话仍加载在宿主内存中' },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            sessionId: String(beta),
            ok: true,
            result: { filesRemoved: true, archiveCleared: true, deletedSubagents: [] },
          },
        ],
      })
    const { renderer, refresh } = section()
    enterBatch(renderer)
    clickButton(renderer, '选中本筛选结果')
    clickButton(renderer, '删除')
    const preview = renderer.root.findAllByProps({ role: 'dialog' })[0]
    expect(
      preview
        .findAll((node: ReactTestInstance) => node.type === 'h1')
        .map((node) => String(node.children[0])),
    ).toContain('确认批量删除')
    expect(
      preview
        .findAll((node: ReactTestInstance) => node.type === 'strong')
        .map((node) => String(node.children[0])),
    ).toContain('Running session')
    await act(async () => {
      preview
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.children.includes('确认删除'))
        .forEach((node) => node.props.onClick())
    })
    expect(runBatch).toHaveBeenCalledExactlyOnceWith({
      action: 'delete',
      sessionIds: [String(alpha), String(running), String(beta)],
      payload: undefined,
    })
    expect(refresh).toHaveBeenCalledOnce()
    const content = text(renderer)
    expect(content.some((value) => value.includes('已删除（含 1 个子会话）'))).toBe(true)
    expect(content.some((value) => value.includes('会话仍加载在宿主内存中'))).toBe(true)
    await act(async () => {
      clickButton(renderer, '重试失败')
    })
    expect(vi.mocked(runBatch)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(runBatch).mock.calls[1]![0].sessionIds).toEqual([String(beta)])
  })
})

describe('词条', () => {
  it('zh 与 en 键集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
