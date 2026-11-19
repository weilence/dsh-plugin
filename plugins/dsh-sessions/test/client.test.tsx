import { useSyncExternalStore, type ComponentProps } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionDialogsEntry } from '../src/client/dialogs'
import { fetchPresets, migrateSessionPreset, migrateSessionToWorkspace } from '../src/client/api'
import { en, zh } from '../src/client/locales'
import { SessionMenuItems } from '../src/client/menu'
import { createRequestsBridge, type SessionDialogRequest } from '../src/client/requests'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconAgentPresetOutlineRegular: () => null,
  IconWorkspaceTreeOutlineRegular: () => null,
  Button: ({
    variant: _variant,
    size: _size,
    ...props
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Button>) => <button {...props} />,
  MenuItemButton: ({
    onSelect,
    disabled,
    disabledReason: _disabledReason,
    icon: _icon,
    separatorBefore: _separatorBefore,
    danger: _danger,
    children,
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').MenuItemButton>) => (
    <button role="menuitem" data-disabled={disabled} onClick={disabled ? undefined : onSelect}>
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
vi.mock('../src/client/api', () => ({
  migrateSessionToWorkspace: vi.fn(async () => ({ ok: true, moved: true, attached: true })),
  fetchPresets: vi.fn(async () => ['coder', 'writer']),
  migrateSessionPreset: vi.fn(async () => ({ migrated: true, oldPreset: 'coder', newPreset: 'writer' })),
}))

const alpha = 'session-alpha' as SessionId
const sub = 'sub-child' as SessionId

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
    archivedSessionIds: [],
    pinnedSessionIds: [],
    ...overrides,
  }
}

function sessionSnapshot(subagent = false) {
  return {
    phase: 'ready' as const,
    ids: [alpha],
    byId: subagent
      ? {
          [alpha]: {
            id: alpha,
            displayTitle: 'Child worker',
            cwd: '/project',
            running: false,
            blank: false,
            retainedBy: {},
            updatedAt: 1_800_000_000_000,
            origin: 'subagent' as const,
            parentId: 'parent' as SessionId,
          },
        }
      : {
          [alpha]: {
            id: alpha,
            displayTitle: 'Alpha investigation',
            cwd: '/project/alpha-cwd',
            running: false,
            blank: false,
            retainedBy: {},
            updatedAt: 1_800_000_000_000,
          },
        },
    projectionsBySession: {},
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

const text = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAll((node: ReactTestInstance) => typeof node.children[0] === 'string')
    .flatMap((node) => node.children.filter((child): child is string => typeof child === 'string'))

const clickButton = (renderer: ReactTestRenderer, label: string): void => {
  const button = renderer.root
    .findAll((node: ReactTestInstance) => node.type === 'button' && node.children.includes(label))
    .find(Boolean)!
  act(() => {
    button.props.onClick()
  })
}

const menuItems = (renderer: ReactTestRenderer): Array<{ label: string; disabled: unknown }> =>
  renderer.root
    .findAll((node: ReactTestInstance) => node.type === 'button' && node.props.role === 'menuitem')
    .map((node) => ({ label: String(node.children[0]), disabled: node.props['data-disabled'] }))

const dialogTitles = (renderer: ReactTestRenderer): string[] =>
  renderer.root
    .findAllByProps({ role: 'dialog' })
    .flatMap((dialog: ReactTestInstance) =>
      dialog.findAll((node: ReactTestInstance) => node.type === 'h1').map((node) => String(node.children[0])),
    )

interface MenuHarnessOptions {
  sessionId?: SessionId
  displayTitle?: string
  subagent?: boolean
}

function menuHarness(options: MenuHarnessOptions = {}) {
  const { sessionId = alpha, displayTitle = 'Alpha investigation', subagent = false } = options
  const sessionSource = source(sessionSnapshot(subagent))
  const bridge = createRequestsBridge()
  const open = vi.fn((request: SessionDialogRequest) => bridge.open(request))
  const setMenuOpen = vi.fn()
  const useSessions: ComponentProps<typeof SessionMenuItems>['useSessions'] = (selector) =>
    selector(useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot))
  const renderer = mount(
    <SessionMenuItems
      {...({
        t: makeT('zh'),
        sessionId,
        displayTitle,
        useMenuOpenState: () => [false, setMenuOpen] as readonly [boolean, (open: boolean) => void],
        useSessions,
        open,
      } as unknown as ComponentProps<typeof SessionMenuItems>)}
    />,
  )
  return { renderer, bridge, open, setMenuOpen }
}

function dialogsHarness(request: SessionDialogRequest | null) {
  const bridge = createRequestsBridge()
  if (request !== null) bridge.open(request)
  const workspaceSource = source(workspaceSnapshot())
  const useWorkspaceList = () => useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot)
  const refresh = vi.fn<ISessions['refresh']>(async () => {})
  const renderer = mount(
    <SessionDialogsEntry
      {...({
        t: makeT('zh'),
        bridge,
        useWorkspaceList,
        refreshSessions: refresh,
      } as unknown as ComponentProps<typeof SessionDialogsEntry>)}
    />,
  )
  return { renderer, bridge, refresh }
}

describe('会话行菜单条目', () => {
  it('两项条目齐全且可用，点击经桥发起对应请求并关闭菜单', () => {
    const { renderer, bridge, setMenuOpen } = menuHarness()
    const items = menuItems(renderer)
    expect(items.map((item) => item.label)).toEqual(['迁移到工作区…', '迁移预设…'])
    expect(items.every((item) => item.disabled === false)).toBe(true)
    act(() => {
      renderer.root
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.props.role === 'menuitem')[0]!
        .props.onClick()
    })
    expect(bridge.get()).toEqual({ kind: 'migrate', sessionId: alpha, title: 'Alpha investigation' })
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    act(() => {
      renderer.root
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.props.role === 'menuitem')[1]!
        .props.onClick()
    })
    expect(bridge.get()).toEqual({ kind: 'preset', sessionId: alpha, title: 'Alpha investigation' })
  })

  it('子会话禁用两项迁移条目', () => {
    const items = menuItems(menuHarness({ subagent: true, displayTitle: 'Child worker' }).renderer)
    expect(items.map((item) => item.disabled)).toEqual([true, true])
  })

  it('行标题为空时弹窗标题回退为会话 ID', () => {
    const { renderer, open, setMenuOpen } = menuHarness({ sessionId: alpha, displayTitle: '' })
    act(() => {
      renderer.root
        .findAll((node: ReactTestInstance) => node.type === 'button' && node.props.role === 'menuitem')[1]!
        .props.onClick()
    })
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(open).toHaveBeenCalledWith({ kind: 'preset', sessionId: alpha, title: alpha })
  })
})

describe('弹窗宿主', () => {
  it('无请求时不渲染弹窗', () => {
    const { renderer } = dialogsHarness(null)
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
  })

  it('迁移与预设请求分发到对应弹窗', () => {
    const migrate = dialogsHarness({ kind: 'migrate', sessionId: alpha, title: 'Alpha investigation' })
    expect(dialogTitles(migrate.renderer)).toContain('迁移会话到工作区')
    const preset = dialogsHarness({ kind: 'preset', sessionId: alpha, title: 'Alpha investigation' })
    expect(dialogTitles(preset.renderer)).toContain('迁移 Agent 预设')
  })

  it('选择工作区提交迁移，归属未完成时提示补救指引', async () => {
    vi.mocked(migrateSessionToWorkspace).mockResolvedValueOnce({
      ok: true,
      moved: true,
      attached: false,
      membershipPending: '已迁移文件，但归入目标工作区失败。请重启宿主后再次迁移',
    })
    const { renderer, refresh } = dialogsHarness({
      kind: 'migrate',
      sessionId: alpha,
      title: 'Alpha investigation',
    })
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
    const { renderer } = dialogsHarness({ kind: 'preset', sessionId: alpha, title: 'Alpha investigation' })
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

describe('词条', () => {
  it('zh 与 en 键集合一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})
