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
import { ImportDialog, SessionsSection, apply } from '../src/client'
import { deleteArchivedSession, importFiles } from '../src/client/api'
import { en, zh } from '../src/client/locales'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({
    variant: _variant,
    ...props
  }: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Button>) => <button {...props} />,
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
}))
vi.mock('../src/client/api', () => ({
  importFiles: vi.fn(async () => {}),
  deleteArchivedSession: vi.fn(async () => ({ filesRemoved: true, archiveCleared: true })),
}))

type SectionProps = ComponentProps<typeof SessionsSection>
const alpha = 'archive-alpha' as SessionId
const beta = 'archive-beta' as SessionId
const missing = 'archive-missing' as SessionId
const retained = 'archive-retained' as SessionId
const active = 'active-session' as SessionId

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
    archivedSessionIds: [alpha, beta],
    pinnedSessionIds: [],
    ...overrides,
  }
}

function summary(id: SessionId, displayTitle: string, cwd: string): SessionSummary {
  return { id, displayTitle, cwd, running: false, blank: false, retainedBy: {}, updatedAt: 1_800_000_000_000 }
}

function sessionSnapshot(overrides: Partial<SessionListState> = {}): SessionListState {
  return {
    phase: 'ready',
    ids: [alpha, beta, active],
    byId: {
      [alpha]: summary(alpha, 'Alpha investigation', '/project/alpha-cwd'),
      [beta]: summary(beta, 'Beta notes', '/other'),
      [active]: summary(active, 'Active session', '/project'),
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

function section(workspace = workspaceSnapshot(), list = sessionSnapshot(), language: 'zh' | 'en' = 'zh') {
  const workspaceSource = source(workspace)
  const sessionSource = source(list)
  const unarchiveSession = vi.fn<IWorkspaces['unarchiveSession']>(async () => {})
  const refresh = vi.fn<ISessions['refresh']>(async () => {})
  const retain = vi.fn<ISessions['retain']>()
  const using = vi.fn<ISessions['using']>()
  const close = vi.fn()
  const useWorkspaces: SectionProps['useWorkspaces'] = (selector) =>
    selector(useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot))
  const useSessions: SectionProps['useSessions'] = (selector) =>
    selector(useSyncExternalStore(sessionSource.subscribe, sessionSource.getSnapshot))
  const props = {
    t: makeT(language),
    formatTime: (timestamp: number) => new Date(timestamp).toLocaleString(language),
    close,
    useWorkspaces,
    useSessions,
    sessions: { list: sessionSource, refresh, retain, using } as unknown as ISessions,
    workspaces: { list: workspaceSource, unarchiveSession } as unknown as IWorkspaces,
  } as SectionProps
  const renderer = mount(<SessionsSection {...props} />)
  return { renderer, props, workspaceSource, sessionSource, unarchiveSession, refresh, retain, using, close }
}

function text(node: ReactTestInstance): string {
  return node.children.map((child) => (typeof child === 'string' ? child : text(child))).join('')
}
function button(node: ReactTestInstance, label: string) {
  return node.findAllByType('button').find((entry) => text(entry) === label)!
}
function rows(renderer: ReactTestRenderer) {
  return renderer.root.findAllByType('li')
}
function rowIds(renderer: ReactTestRenderer) {
  return rows(renderer).map((row) => text(row.findAllByType('code')[0]!))
}
function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function dialog(value = workspaceSnapshot(), language: 'zh' | 'en' = 'zh') {
  const workspaceSource = source(value)
  const useWorkspaces: SectionProps['useWorkspaces'] = (selector) =>
    selector(useSyncExternalStore(workspaceSource.subscribe, workspaceSource.getSnapshot))
  const onImported = vi.fn(async () => {})
  const onClose = vi.fn()
  const renderer = mount(
    <ImportDialog
      t={makeT(language)}
      useWorkspaces={useWorkspaces}
      onImported={onImported}
      onClose={onClose}
    />,
  )
  return { renderer, onImported, onClose, workspaceSource }
}

describe('会话设置与导入弹窗', () => {
  it('常驻导入按钮最初不挂载弹窗、ZIP 或工作区表单，点击后才打开并可关闭', () => {
    const { renderer, close } = section()
    expect(button(renderer.root, zh.import).props.disabled).not.toBe(true)
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(renderer.root.findAllByType('select')).toHaveLength(0)
    expect(renderer.root.findAllByProps({ type: 'file' })).toHaveLength(0)
    act(() => button(renderer.root, zh.import).props.onClick())
    const modal = renderer.root.findByProps({ role: 'dialog' })
    expect(modal.findByType('select').props.value).toBe('')
    expect(modal.findByProps({ type: 'file' }).props.multiple).toBe(true)
    act(() => button(modal, '关闭').props.onClick())
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    expect(close).not.toHaveBeenCalled()
    act(() => button(renderer.root, zh.import).props.onClick())
    const reopened = renderer.root.findByProps({ role: 'dialog' })
    act(() => reopened.findByProps({ 'aria-label': '关闭' }).props.onClick())
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
  })

  it('导入不猜测工作区，多选可信 ZIP 后才允许提交，成功仅刷新列表', async () => {
    const { renderer, refresh, retain, using } = section()
    act(() => button(renderer.root, zh.import).props.onClick())
    const modal = renderer.root.findByProps({ role: 'dialog' })
    const target = modal.findByType('select')
    const fileInput = modal.findByProps({ type: 'file' })
    expect(target.props.value).toBe('')
    expect(text(modal)).toContain('Example workspace — /project')
    expect(fileInput.props.accept).toBe('.zip,application/zip')
    expect(fileInput.props.multiple).toBe(true)
    expect(text(modal)).toContain(zh.warning)
    expect(button(modal, zh.import).props.disabled).toBe(true)
    const files = [{ name: 'one.zip' }, { name: 'two.zip' }] as File[]
    act(() => fileInput.props.onChange({ target: { files } }))
    expect(button(modal, zh.import).props.disabled).toBe(true)
    act(() => target.props.onChange({ target: { value: 'project' } }))
    expect(button(modal, zh.import).props.disabled).toBe(false)
    await act(async () => {
      button(modal, zh.import).props.onClick()
    })
    expect(importFiles).toHaveBeenCalledWith(files, '/project', expect.any(Function))
    expect(refresh).toHaveBeenCalledOnce()
    expect(retain).not.toHaveBeenCalled()
    expect(using).not.toHaveBeenCalled()
  })

  it('弹窗保留工作区加载、空列表和真实错误反馈', () => {
    const pending = dialog(workspaceSnapshot({ phase: 'pending', state: 'loading', items: [] })).renderer
    expect(text(pending.root)).toContain(zh['workspace.loading'])
    expect(pending.root.findByType('select').props.disabled).toBe(true)
    expect(text(dialog(workspaceSnapshot({ items: [] })).renderer.root)).toContain(zh['workspace.empty'])
    const failed = dialog(
      workspaceSnapshot({
        state: 'error',
        error: { code: 'carrier/failure', message: 'Connection refused' } as never,
      }),
    ).renderer
    expect(text(failed.root)).toContain('carrier/failure: Connection refused')
    expect(failed.root.findByType('select').props.disabled).toBe(true)
    expect(button(failed.root, zh.import).props.disabled).toBe(true)
  })

  it('词典键集一致，现有面板与弹窗响应宿主语言切换', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const { renderer, props } = section()
    const timestamp = 1_800_000_000_000
    expect(text(rows(renderer)[0]!.findByType('time'))).toContain(new Date(timestamp).toLocaleString('zh'))
    act(() => button(renderer.root, zh.import).props.onClick())
    act(() =>
      renderer.update(
        <SessionsSection
          {...props}
          t={makeT('en')}
          formatTime={(value) => new Date(value).toLocaleString('en')}
        />,
      ),
    )
    expect(text(rows(renderer)[0]!.findByType('time'))).toBe(
      makeT('en')('archive.updated', { time: new Date(timestamp).toLocaleString('en') }),
    )
    const modal = renderer.root.findByProps({ role: 'dialog' })
    expect(text(modal)).toContain(en.workspace)
    expect(text(modal)).toContain(en.files)
    expect(text(modal)).toContain(en.warning)
    expect(text(modal)).toContain('Close')
    expect(text(renderer.root)).toContain(en['archive.title'])
    expect(text(renderer.root)).not.toContain(zh.workspace)
    expect(button(modal, en.import).props.disabled).toBe(true)
  })
})

describe('官方归档列表与恢复', () => {
  it('以归档 ID 为事实源，缺失元数据仍保留条目且可以恢复；忽略非 Host 成员的保留信息', async () => {
    const list = sessionSnapshot()
    list.byId[retained] = summary(retained, 'Retained fallback must not appear', '/retained-only')
    const { renderer, unarchiveSession } = section(
      workspaceSnapshot({ archivedSessionIds: [alpha, missing, retained] }),
      list,
    )
    expect(rowIds(renderer)).toEqual([alpha, missing, retained])
    expect(text(renderer.root)).not.toContain('Active session')
    expect(text(renderer.root)).not.toContain('Retained fallback must not appear')
    expect(text(renderer.root)).not.toContain('/retained-only')
    expect(text(rows(renderer)[1]!)).toContain(zh['archive.metadataUnavailable'])
    expect(text(rows(renderer)[2]!)).toContain(zh['archive.metadataUnavailable'])
    expect(button(rows(renderer)[1]!, zh['archive.restore']).props.disabled).toBe(false)
    await act(async () => {
      button(rows(renderer)[1]!, zh['archive.restore']).props.onClick()
    })
    expect(unarchiveSession).toHaveBeenCalledWith(missing)
  })

  it('会话元数据的官方快照更新会刷新归档条目，不把尚未加载误当作空归档', () => {
    const { renderer, sessionSource } = section(
      workspaceSnapshot(),
      sessionSnapshot({ phase: 'pending', ids: [], byId: {} }),
    )
    expect(rowIds(renderer)).toEqual([alpha, beta])
    expect(text(renderer.root)).toContain(zh['archive.metadataLoading'])
    expect(text(renderer.root)).not.toContain(zh['archive.empty'])
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(false)
    act(() => sessionSource.set(sessionSnapshot()))
    expect(text(renderer.root)).toContain('Alpha investigation')
    expect(text(renderer.root)).not.toContain(zh['archive.metadataLoading'])
  })

  it('恢复只提交正确 ID，同一轮双击和其他条目请求均被拦截，行只随官方快照移除', async () => {
    const { renderer, workspaceSource, unarchiveSession, refresh, retain, using, close } = section()
    const request = deferred()
    unarchiveSession.mockReturnValueOnce(request.promise)
    const firstClick = button(rows(renderer)[0]!, zh['archive.restore']).props.onClick
    const otherClick = button(rows(renderer)[1]!, zh['archive.restore']).props.onClick
    act(() => {
      firstClick()
      firstClick()
      otherClick()
    })
    expect(unarchiveSession).toHaveBeenCalledExactlyOnceWith(alpha)
    expect(button(rows(renderer)[0]!, zh['archive.restoring']).props.disabled).toBe(true)
    expect(button(rows(renderer)[1]!, zh['archive.restore']).props.disabled).toBe(true)
    await act(async () => {
      request.resolve()
      await request.promise
    })
    expect(rowIds(renderer)).toEqual([alpha, beta])
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(false)
    expect(refresh).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    expect(using).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    act(() => workspaceSource.set(workspaceSnapshot({ archivedSessionIds: [beta] })))
    expect(rowIds(renderer)).toEqual([beta])
  })

  it('失败保留条目和真实错误，可再次恢复；外部错误不随语言切换改写', async () => {
    const { renderer, props, unarchiveSession } = section()
    unarchiveSession.mockRejectedValueOnce(new Error('unarchive carrier: connection reset'))
    await act(async () => {
      button(rows(renderer)[0]!, zh['archive.restore']).props.onClick()
    })
    expect(rowIds(renderer)).toEqual([alpha, beta])
    expect(text(rows(renderer)[0]!)).toContain('unarchive carrier: connection reset')
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(false)
    act(() => renderer.update(<SessionsSection {...props} t={makeT('en')} />))
    expect(text(rows(renderer)[0]!)).toContain('unarchive carrier: connection reset')
    await act(async () => {
      button(rows(renderer)[0]!, en['archive.restore']).props.onClick()
    })
    expect(unarchiveSession).toHaveBeenCalledTimes(2)
    expect(unarchiveSession).toHaveBeenNthCalledWith(2, alpha)
    expect(text(renderer.root)).not.toContain('unarchive carrier: connection reset')
    expect(text(renderer.root)).toContain('Unarchived: Alpha investigation')
  })

  it('follow 先移除恢复中的条目时，稍后失败仍展示真实原因', async () => {
    const { renderer, workspaceSource, unarchiveSession } = section()
    const request = deferred()
    unarchiveSession.mockReturnValueOnce(request.promise)
    act(() => button(rows(renderer)[0]!, zh['archive.restore']).props.onClick())
    act(() => workspaceSource.set(workspaceSnapshot({ archivedSessionIds: [beta] })))
    expect(rowIds(renderer)).toEqual([beta])
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(true)
    await act(async () => {
      request.reject(new Error('unarchive reply lost after follow'))
      await request.promise.catch(() => {})
    })
    expect(text(renderer.root)).toContain('unarchive reply lost after follow')
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(false)
  })

  it.each([
    { phase: 'pending', state: 'loading', error: null },
    { phase: 'ready', state: 'loading', error: null },
    { phase: 'ready', state: 'error', error: { code: 'carrier/failure', message: 'Follow disconnected' } },
  ] as Partial<WorkspaceSnapshot>[])('旧点击在最新官方状态 $phase/$state 不可用时不提交', async (state) => {
    const { renderer, workspaceSource, unarchiveSession } = section()
    const staleClick = button(rows(renderer)[0]!, zh['archive.restore']).props.onClick
    workspaceSource.set(workspaceSnapshot(state), false)
    await act(async () => {
      staleClick()
    })
    expect(unarchiveSession).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(
      state.error ? 'carrier/failure: Follow disconnected' : zh['archive.unavailable'],
    )
  })

  it('旧点击读取最新归档成员关系，已经恢复时跳过官方命令并提示', async () => {
    const { renderer, workspaceSource, unarchiveSession } = section()
    const staleClick = button(rows(renderer)[0]!, zh['archive.restore']).props.onClick
    workspaceSource.set(workspaceSnapshot({ archivedSessionIds: [beta] }), false)
    await act(async () => {
      staleClick()
    })
    expect(unarchiveSession).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain(
      makeT()('archive.alreadyRestored', { title: 'Alpha investigation' }),
    )
  })

  it('follow 加载和失败禁用恢复，读取失败不会显示假空列表', () => {
    const { renderer, workspaceSource } = section()
    act(() => workspaceSource.set(workspaceSnapshot({ state: 'loading' })))
    expect(text(renderer.root)).toContain(zh['archive.loading'])
    expect(rows(renderer).every((row) => button(row, zh['archive.restore']).props.disabled)).toBe(true)
    act(() =>
      workspaceSource.set(
        workspaceSnapshot({
          state: 'error',
          error: { code: 'carrier/failure', message: 'Archive read refused' } as never,
        }),
      ),
    )
    expect(text(renderer.root)).toContain('carrier/failure: Archive read refused')
    expect(rows(renderer).every((row) => button(row, zh['archive.restore']).props.disabled)).toBe(true)
    act(() =>
      workspaceSource.set(workspaceSnapshot({ phase: 'pending', state: 'loading', archivedSessionIds: [] })),
    )
    expect(text(renderer.root)).toContain(zh['archive.loading'])
    expect(
      renderer.root
        .findAllByType('button')
        .filter((entry) => text(entry) === zh['archive.restore'] && !entry.props.disabled),
    ).toHaveLength(0)
    expect(text(renderer.root)).not.toContain(zh['archive.empty'])
    act(() =>
      workspaceSource.set(
        workspaceSnapshot({
          state: 'error',
          archivedSessionIds: [],
          error: { code: 'carrier/failure', message: 'No baseline' } as never,
        }),
      ),
    )
    expect(text(renderer.root)).toContain('carrier/failure: No baseline')
    expect(text(renderer.root)).not.toContain(zh['archive.empty'])
    expect(text(renderer.root)).not.toContain(zh['archive.noMatch'])
  })

  it.each([' ALPHA investigation ', 'ARCHIVE-ALPHA', 'alpha-cwd', 'Example workspace', '/project'])(
    '搜索匹配标题、ID、cwd 或工作区：%s',
    (query) => {
      const { renderer } = section()
      act(() => renderer.root.findByProps({ type: 'search' }).props.onChange({ target: { value: query } }))
      expect(rowIds(renderer)).toEqual([alpha])
    },
  )

  it('区分没有归档和搜索无匹配，清空搜索后恢复列表', () => {
    const { renderer, workspaceSource } = section()
    const search = renderer.root.findByProps({ type: 'search' })
    act(() => search.props.onChange({ target: { value: 'not-found' } }))
    expect(rows(renderer)).toHaveLength(0)
    expect(text(renderer.root)).toContain(zh['archive.noMatch'])
    expect(text(renderer.root)).not.toContain(zh['archive.empty'])
    act(() => search.props.onChange({ target: { value: '' } }))
    expect(rowIds(renderer)).toEqual([alpha, beta])
    act(() => workspaceSource.set(workspaceSnapshot({ archivedSessionIds: [] })))
    expect(text(renderer.root)).toContain(zh['archive.empty'])
    expect(text(renderer.root)).not.toContain(zh['archive.noMatch'])
  })
})

describe('归档会话删除', () => {
  function confirmDialog(renderer: ReactTestRenderer) {
    return renderer.root.findByProps({ role: 'dialog' })
  }

  it('点击删除先确认，取消不请求，确认后才提交并提示成功', async () => {
    const { renderer, workspaceSource } = section()
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    expect(text(confirmDialog(renderer))).toContain('将永久删除会话「Alpha investigation」的日志文件')
    expect(deleteArchivedSession).not.toHaveBeenCalled()
    act(() => button(confirmDialog(renderer), '取消').props.onClick())
    expect(renderer.root.findAllByProps({ role: 'dialog' })).toHaveLength(0)
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(renderer), zh['archive.delete']).props.onClick()
    })
    expect(deleteArchivedSession).toHaveBeenCalledExactlyOnceWith(alpha)
    expect(text(renderer.root)).toContain('已删除：Alpha investigation')
    expect(rowIds(renderer)).toEqual([alpha, beta])
    act(() => workspaceSource.set(workspaceSnapshot({ archivedSessionIds: [beta] })))
    expect(rowIds(renderer)).toEqual([beta])
  })

  it('删除成功后刷新官方会话列表，过期摘要否则让会话重新出现在侧栏', async () => {
    const { renderer, refresh } = section()
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(renderer), zh['archive.delete']).props.onClick()
    })
    expect(deleteArchivedSession).toHaveBeenCalledExactlyOnceWith(alpha)
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('删除失败或归档条目未清除时不刷新列表；刷新失败单独提示且不掩盖删除成功', async () => {
    vi.mocked(deleteArchivedSession).mockRejectedValueOnce(new Error('会话仍有进行中的活动，已拒绝删除'))
    const failed = section()
    act(() => button(rows(failed.renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(failed.renderer), zh['archive.delete']).props.onClick()
    })
    expect(failed.refresh).not.toHaveBeenCalled()
    vi.mocked(deleteArchivedSession).mockResolvedValueOnce({
      filesRemoved: true,
      archiveCleared: false,
      archiveClearError: 'registry unavailable',
    })
    const gated = section()
    act(() => button(rows(gated.renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(gated.renderer), zh['archive.delete']).props.onClick()
    })
    expect(gated.refresh).not.toHaveBeenCalled()
    const refreshed = section()
    refreshed.refresh.mockRejectedValueOnce(new Error('refresh carrier: connection reset'))
    act(() => button(rows(refreshed.renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(refreshed.renderer), zh['archive.delete']).props.onClick()
    })
    expect(refreshed.refresh).toHaveBeenCalledOnce()
    expect(text(refreshed.renderer.root)).toContain('已删除：Alpha investigation')
    expect(text(refreshed.renderer.root)).toContain('刷新会话列表失败：refresh carrier: connection reset')
  })

  it('删除与恢复共用互斥，进行中双向禁用', async () => {
    const { renderer, unarchiveSession } = section()
    const gate = deferred()
    unarchiveSession.mockReturnValueOnce(gate.promise)
    act(() => button(rows(renderer)[0]!, zh['archive.restore']).props.onClick())
    expect(button(rows(renderer)[1]!, zh['archive.delete']).props.disabled).toBe(true)
    await act(async () => {
      gate.resolve()
      await gate.promise
    })
    let releaseDelete!: (value: { filesRemoved: boolean; archiveCleared: boolean }) => void
    const deleteGate = new Promise<{ filesRemoved: boolean; archiveCleared: boolean }>((resolve) => {
      releaseDelete = resolve
    })
    vi.mocked(deleteArchivedSession).mockReturnValueOnce(deleteGate)
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    act(() => button(confirmDialog(renderer), zh['archive.delete']).props.onClick())
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(true)
    expect(button(rows(renderer)[1]!, zh['archive.restore']).props.disabled).toBe(true)
    expect(unarchiveSession).toHaveBeenCalledTimes(1)
    await act(async () => {
      releaseDelete({ filesRemoved: true, archiveCleared: true })
      await deleteGate
    })
    expect(button(rows(renderer)[0]!, zh['archive.restore']).props.disabled).toBe(false)
    expect(text(renderer.root)).toContain('已删除：Alpha investigation')
  })

  it('删除失败保留条目与真实原因，可重试', async () => {
    vi.mocked(deleteArchivedSession).mockRejectedValueOnce(new Error('目录不含官方 v4 会话日志，拒绝删除'))
    const { renderer } = section()
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(renderer), zh['archive.delete']).props.onClick()
    })
    expect(text(rows(renderer)[0]!)).toContain('目录不含官方 v4 会话日志，拒绝删除')
    expect(rowIds(renderer)).toEqual([alpha, beta])
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(renderer), zh['archive.delete']).props.onClick()
    })
    expect(deleteArchivedSession).toHaveBeenCalledTimes(2)
    expect(text(renderer.root)).toContain('已删除：Alpha investigation')
  })

  it('官方服务报告无文件或归档清理失败时分别提示', async () => {
    vi.mocked(deleteArchivedSession).mockResolvedValueOnce({ filesRemoved: false, archiveCleared: true })
    const { renderer } = section()
    act(() => button(rows(renderer)[1]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(renderer), zh['archive.delete']).props.onClick()
    })
    expect(text(renderer.root)).toContain('未找到日志文件，仅清除了归档条目：Beta notes')
    vi.mocked(deleteArchivedSession).mockResolvedValueOnce({
      filesRemoved: true,
      archiveCleared: false,
      archiveClearError: 'registry unavailable',
    })
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    await act(async () => {
      button(confirmDialog(renderer), zh['archive.delete']).props.onClick()
    })
    expect(text(renderer.root)).toContain('日志已删除，但清除归档条目失败：registry unavailable')
  })

  it('归档快照已变更的旧确认点击跳过请求并提示', async () => {
    const { renderer, workspaceSource } = section()
    act(() => button(rows(renderer)[0]!, zh['archive.delete']).props.onClick())
    const staleConfirm = button(confirmDialog(renderer), zh['archive.delete']).props.onClick
    workspaceSource.set(workspaceSnapshot({ archivedSessionIds: [beta] }), false)
    await act(async () => {
      staleConfirm()
    })
    expect(deleteArchivedSession).not.toHaveBeenCalled()
    expect(text(renderer.root)).toContain('此会话已不在归档列表中：Alpha investigation')
  })

  it('删除入口跟随宿主语言', async () => {
    const { renderer } = section(workspaceSnapshot(), sessionSnapshot(), 'en')
    expect(text(renderer.root)).toContain(en['archive.delete'])
    act(() => button(rows(renderer)[0]!, en['archive.delete']).props.onClick())
    expect(text(confirmDialog(renderer))).toContain(
      'permanently deletes the log files of "Alpha investigation"',
    )
    await act(async () => {
      button(confirmDialog(renderer), en['archive.delete']).props.onClick()
    })
    expect(text(renderer.root)).toContain('Deleted: Alpha investigation')
  })
})

it('只注册 settings.section，注入官方服务，导航 label thunk 随宿主语言变化', () => {
  let language: 'zh' | 'en' = 'zh'
  const sessions = {} as ISessions
  const workspaces = {} as IWorkspaces
  const registerLocale = vi.fn(() => () => {})
  const bind = vi.fn(() => (key: Parameters<ReturnType<typeof makeT>>[0]) => makeT(language)(key))
  const register = vi.fn()
  const inject = vi.fn((_slot: string, callback: () => unknown) => callback())
  const context = {
    sessions,
    workspaces,
    effect(callback: () => unknown) {
      callback()
    },
    locale: { register: registerLocale, bind, getSnapshot: () => ({ active: language }) },
    slots: { inject, register },
  } as unknown as Parameters<typeof apply>[0]
  apply(context)
  expect(registerLocale).toHaveBeenCalledWith('dsh-sessions', { zh, en })
  expect(bind).toHaveBeenCalledWith('dsh-sessions')
  expect(inject).toHaveBeenCalledExactlyOnceWith('settings.section', expect.any(Function))
  expect(register).toHaveBeenCalledOnce()
  const [meta, component] = register.mock.calls[0]!
  expect(meta).toMatchObject({ name: 'settings.section', id: 'dsh-sessions', locale: 'dsh-sessions' })
  expect(meta).not.toHaveProperty('key')
  expect(component).toBe(SessionsSection)
  const injected = meta.inject()
  expect(injected).toEqual({ sessions, workspaces, formatTime: expect.any(Function) })
  expect(injected.sessions).toBe(sessions)
  expect(injected.workspaces).toBe(workspaces)
  const timestamp = 1_800_000_000_000
  expect(injected.formatTime(timestamp)).toBe(new Date(timestamp).toLocaleString('zh'))
  expect(meta.label).toBeTypeOf('function')
  expect(meta.label()).toBe(zh['section.label'])
  language = 'en'
  expect(meta.label()).toBe(en['section.label'])
  expect(injected.formatTime(timestamp)).toBe(new Date(timestamp).toLocaleString('en'))
})
