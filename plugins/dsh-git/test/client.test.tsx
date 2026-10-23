import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReposBody } from '../src/client/ReposBody'
import {
  FILES_PATH,
  LOG_PATH,
  REPOS_PATH,
  type GitCommitFiles,
  type GitLog,
  type GitRepoScan,
} from '../src/shared'
import { makeT } from './i18n'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').Button>) => (
    <button {...props} />
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  IconRefreshOutlineRegular: () => null,
}))

const t = makeT()
const formatTime = (timestampMs: number): string => `T${timestampMs}`

function renderBody(cwd: string | undefined): ReactTestRenderer {
  const sessionsState = { byId: cwd === undefined ? {} : { session: { cwd } } }
  const props = {
    sessionId: 'session',
    useSessions: (selector: (state: typeof sessionsState) => unknown) => selector(sessionsState),
    t,
    formatTime,
  } as ComponentProps<typeof ReposBody>
  return create(<ReposBody {...props} />)
}

function texts(tree: ReactTestRenderer): string[] {
  const found: string[] = []
  for (const node of tree.root.findAll(() => true)) {
    for (const value of node.children) {
      if (typeof value === 'string') found.push(value)
    }
  }
  return found
}

const scanOf = (roots: readonly string[]): GitRepoScan => ({
  root: '/workspace',
  truncated: false,
  repos: roots.map((name, index) => ({
    root: `/workspace/${name}`,
    name,
    relPath: name,
    kind: 'standard' as const,
    branch: index === 0 ? 'main' : undefined,
  })),
})

const logOf = (): GitLog => ({
  truncated: false,
  commits: [
    {
      hash: 'c3' + '0'.repeat(38),
      parents: ['c2' + '0'.repeat(38)],
      authorName: 'Li Lei',
      authorEmail: 'lilei@example.com',
      timestamp: 1_700_000_100,
      subject: 'merge feature',
      headBranch: 'main',
      branches: ['main'],
      remotes: ['origin/main'],
      tags: [],
    },
    {
      hash: 'c2' + '0'.repeat(38),
      parents: ['c1' + '0'.repeat(38)],
      authorName: 'Han Meimei',
      authorEmail: 'han@example.com',
      timestamp: 1_700_000_000,
      subject: 'add feature',
      branches: [],
      remotes: [],
      tags: ['v1.0.0'],
    },
    {
      hash: 'c1' + '0'.repeat(38),
      parents: [],
      authorName: 'Li Lei',
      authorEmail: 'lilei@example.com',
      timestamp: 1_699_999_900,
      subject: 'init',
      branches: [],
      remotes: [],
      tags: [],
    },
  ],
})

const HEAD_HASH = 'c3' + '0'.repeat(38)

function filesOf(): GitCommitFiles {
  return {
    hash: HEAD_HASH,
    files: [
      { path: 'src/new.ts', status: 'added', added: 12, deleted: 0 },
      { path: 'src/gone.ts', status: 'deleted', deleted: 3 },
      { path: 'src/moved.ts', oldPath: 'src/origin.ts', status: 'renamed', added: 1, deleted: 0 },
      { path: 'src/binary.png', status: 'modified' },
    ],
  }
}

function stubFetch(
  results: {
    scan?: GitRepoScan
    log?: GitLog | { error: string }
    files?: GitCommitFiles | { error: string }
  } = {},
) {
  return vi.fn(async (path: string, _init: RequestInit) => {
    if (path === REPOS_PATH) return Response.json(results.scan ?? scanOf(['alpha', 'beta']))
    if (path === LOG_PATH) {
      const log = results.log
      if (log !== undefined && 'error' in log) return Response.json(log, { status: 400 })
      return Response.json(log ?? logOf())
    }
    if (path === FILES_PATH) {
      const files = results.files
      if (files !== undefined && 'error' in files) return Response.json(files, { status: 400 })
      return Response.json(files ?? filesOf())
    }
    throw new Error(`unexpected ${path}`)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe('Git 仓库标签体', () => {
  it('扫描后默认选中首个仓库并渲染提交图、refs 芯片与计数', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody('/workspace')
    })
    expect(fetchMock).toHaveBeenCalledWith(
      REPOS_PATH,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ cwd: '/workspace' }) }),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      LOG_PATH,
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ repo: '/workspace/alpha', limit: 500 }),
      }),
    )
    expect(tree.root.findAll((node: ReactTestInstance) => node.type === 'option')).toHaveLength(2)
    const visible = texts(tree)
    expect(visible).toContain('HEAD → main')
    expect(visible).toContain('origin/main')
    expect(visible).toContain('v1.0.0')
    expect(visible).toContain('merge feature')
    expect(visible).toContain('Li Lei')
    expect(visible).toContain(formatTime(1_700_000_100 * 1000))
    expect(visible).toContain(t('log.count', { count: 3 }))
    expect(visible).toContain('/workspace/alpha')
    expect(visible).toContain('main')
  })

  it('切换仓库下拉即改读对应仓库的提交', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody('/workspace')
    })
    await act(async () => {
      tree.root
        .findByProps({ 'aria-label': t('repo.select') })
        .props.onChange({ target: { value: '/workspace/beta' } })
    })
    const calls = fetchMock.mock.calls.filter(([path]: readonly unknown[]) => path === LOG_PATH)
    expect(calls).toHaveLength(2)
    expect(JSON.parse(String(calls[1]![1].body))).toEqual({ repo: '/workspace/beta', limit: 500 })
    expect(texts(tree)).toContain('merge feature')
  })

  it('会话没有 cwd 时不发请求，显示原因', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody(undefined)
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(t('scan.noCwd'))
  })

  it('扫描失败与读提交失败均行内常驻，刷新成功后展示结果', async () => {
    let logCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path === REPOS_PATH) return Response.json(scanOf(['alpha']))
        logCalls++
        return logCalls === 1
          ? Response.json({ error: 'git 不可用：PATH 中未找到 git 可执行文件' }, { status: 400 })
          : Response.json(logOf())
      }),
    )
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody('/workspace')
    })
    expect(texts(tree)).toContain('git 不可用：PATH 中未找到 git 可执行文件')
    await act(async () => {
      tree.root.findByProps({ 'aria-label': t('refresh') }).props.onClick()
    })
    const visible = texts(tree)
    expect(visible).toContain('merge feature')
    expect(visible).not.toContain('git 不可用')
  })

  it('整行点击展开提交号、邮箱与文件变更；缓存后重开不再请求；划选文本不触发展开', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    // 整行点击的选区仲裁读 window.getSelection（node 测试环境无该 API）
    vi.stubGlobal('window', { getSelection: () => null })
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody('/workspace')
    })
    const rows = tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] === false)
    expect(rows).toHaveLength(3)
    await act(async () => {
      rows[0]!.props.onClick({})
    })
    // 文件变更按需读取
    const filesCalls = fetchMock.mock.calls.filter(([path]: readonly unknown[]) => path === FILES_PATH)
    expect(filesCalls).toHaveLength(1)
    expect(JSON.parse(String(filesCalls[0]![1].body))).toEqual({ repo: '/workspace/alpha', hash: HEAD_HASH })
    const expanded = texts(tree)
    expect(expanded).toContain(HEAD_HASH)
    expect(expanded).toContain('lilei@example.com')
    expect(expanded).toContain(t('log.files', { count: 4 }))
    expect(expanded).toContain('src/new.ts')
    expect(expanded).toContain('+12')
    expect(expanded).toContain('-3')
    expect(expanded).toContain('src/origin.ts → src/moved.ts')
    expect(expanded).toContain('src/binary.png')
    await act(async () => {
      tree.root
        .findByProps({ 'aria-expanded': true })
        .props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    })
    expect(texts(tree)).not.toContain(HEAD_HASH)
    // 重开命中缓存，不再发文件请求
    await act(async () => {
      rows[0]!.props.onClick({})
    })
    expect(fetchMock.mock.calls.filter(([path]: readonly unknown[]) => path === FILES_PATH)).toHaveLength(1)
    expect(texts(tree)).toContain('src/new.ts')
    await act(async () => {
      tree.root
        .findByProps({ 'aria-expanded': true })
        .props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    })
    // 划选行内文本松开时派发的 click 只当选择
    vi.stubGlobal('window', { getSelection: () => ({ isCollapsed: false, anchorNode: {} }) })
    await act(async () => {
      rows[0]!.props.onClick({ currentTarget: { contains: () => true } })
    })
    expect(
      tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] === false),
    ).toHaveLength(3)
  })

  it('扫描截断与空提交分别给出提示', async () => {
    vi.stubGlobal(
      'fetch',
      stubFetch({ scan: { ...scanOf(['alpha']), truncated: true }, log: { commits: [], truncated: true } }),
    )
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody('/workspace')
    })
    const visible = texts(tree)
    expect(visible).toContain(t('scan.truncated'))
    expect(visible).toContain(t('log.empty'))
  })
})
