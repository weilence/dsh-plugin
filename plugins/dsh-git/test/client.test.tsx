import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReposBody } from '../src/client/ReposBody'
import { ConfigSection } from '../src/client/ConfigSection'
import { DEFAULT_HOVER_DELAY_MS, getHoverDelay, setHoverDelay } from '../src/client/hoverDelay'
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
  // 官方 Checkbox 的桩：镜像「input + 文案标签」契约，测试按 type=checkbox 驱动。
  Checkbox: ({
    checked,
    onChange,
    label,
  }: {
    checked: boolean
    onChange: (next: boolean) => void
    label: string
  }) => (
    <label>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {label}
    </label>
  ),
  // SettingsValueField 的桩：真实产物外置依赖过多无法整体加载，这里按官方 DOM
  // 契约镜像其结构——覆盖徽标 + 恢复默认同现、aria-invalid、说明与错误单槽互斥。
  SettingsValueField: (
    props: ComponentProps<typeof import('@deepseek-ai/dsh-client-ui-primitives').SettingsValueField>,
  ) => (
    <div>
      <div>
        <label htmlFor={props.id}>{props.label}</label>
        {props.overridden ? (
          <span>
            <span>{props.overriddenLabel}</span>
            <button type="button" disabled={props.disabled} onClick={props.onReset}>
              {props.resetLabel}
            </button>
          </span>
        ) : null}
      </div>
      <input
        id={props.id}
        value={props.text}
        disabled={props.disabled}
        {...(props.invalid ? { 'aria-invalid': true } : {})}
        onChange={(event) => props.onEdit(event.target.value)}
      />
      {props.invalid ? <p>{props.invalidLabel}</p> : props.hint !== undefined ? <p>{props.hint}</p> : null}
    </div>
  ),
}))

const t = makeT()
const formatTime = (timestampMs: number): string => `T${timestampMs}`
const formatRelative = (timestampMs: number): string => `R${timestampMs}`

function renderBody(cwd: string | undefined): ReactTestRenderer {
  const sessionsState = { byId: cwd === undefined ? {} : { session: { cwd } } }
  const props = {
    sessionId: 'session',
    useSessions: (selector: (state: typeof sessionsState) => unknown) => selector(sessionsState),
    t,
    formatTime,
    formatRelative,
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
      body: '合并 feature 分支',
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
      body: '',
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
      body: '',
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
  it('扫描后默认选中首个仓库；收起行默认只显示主题，勾选后显示作者与时间，refs 芯片在展开详情', async () => {
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
    const collapsed = () =>
      tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] === false)
    // 收起行默认只有主题；作者与时间不显示，顶部也不再有路径与分支
    const visible = texts(tree)
    expect(visible).toContain('merge feature')
    expect(visible).not.toContain('Li Lei')
    expect(visible).not.toContain(formatTime(1_700_000_100 * 1000))
    expect(visible).toContain(t('log.count', { count: 3 }))
    expect(visible).toContain('alpha（alpha）')
    expect(visible).not.toContain('/workspace/alpha')
    expect(visible).not.toContain('HEAD → main')
    // 勾选「显示作者 / 时间」后行内出现作者与时间
    await act(async () => {
      tree.root.findByProps({ type: 'checkbox' }).props.onChange({ target: { checked: true } })
    })
    const withMeta = texts(tree)
    expect(withMeta).toContain('Li Lei')
    expect(withMeta).toContain(formatTime(1_700_000_100 * 1000))
    // 展开顶部提交：refs 芯片进详情（提交号 / 邮箱只在悬停卡片）
    await act(async () => {
      collapsed()[0]!.props.onClick({})
    })
    const head = texts(tree)
    expect(head).toContain('HEAD → main')
    expect(head).toContain('origin/main')
    // 展开第二个提交：标签芯片显示
    await act(async () => {
      collapsed()[0]!.props.onClick({})
    })
    expect(texts(tree)).toContain('v1.0.0')
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

  it('整行点击展开 refs 芯片与文件变更清单；详情区点击不收起；缓存后重开不再请求', async () => {
    const fetchMock = stubFetch()
    vi.stubGlobal('fetch', fetchMock)
    let tree!: ReactTestRenderer
    await act(async () => {
      tree = renderBody('/workspace')
    })
    const collapsedRows = () =>
      tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] === false)
    const rows = collapsedRows()
    expect(rows).toHaveLength(3)
    await act(async () => {
      rows[0]!.props.onClick({})
    })
    // 文件变更按需读取
    const filesCalls = fetchMock.mock.calls.filter(([path]: readonly unknown[]) => path === FILES_PATH)
    expect(filesCalls).toHaveLength(1)
    expect(JSON.parse(String(filesCalls[0]![1].body))).toEqual({ repo: '/workspace/alpha', hash: HEAD_HASH })
    const expanded = texts(tree)
    expect(expanded).toContain('HEAD → main')
    expect(expanded).toContain('origin/main')
    expect(expanded).toContain('src/new.ts')
    expect(expanded).toContain('+12')
    expect(expanded).toContain('-3')
    expect(expanded).toContain('src/origin.ts → src/moved.ts')
    expect(expanded).toContain('src/binary.png')
    // 提交号、邮箱与变更计数只在悬停卡片，不在展开详情
    expect(expanded).not.toContain(HEAD_HASH)
    expect(expanded).not.toContain('<lilei@example.com>')
    expect(expanded).not.toContain(t('log.summary', { count: 4, added: 13, deleted: 3 }))
    // 详情区（refs / 文件清单）点击完全不参与切换，展开保持
    await act(async () => {
      tree.root.findByProps({ 'aria-expanded': true }).props.onClick({ target: { closest: () => ({}) } })
    })
    expect(texts(tree)).toContain('src/new.ts')
    // 键盘收起
    await act(async () => {
      tree.root
        .findByProps({ 'aria-expanded': true })
        .props.onKeyDown({ key: 'Enter', preventDefault: () => {} })
    })
    expect(texts(tree)).not.toContain('src/new.ts')
    // 重开命中缓存，不再发文件请求
    await act(async () => {
      rows[0]!.props.onClick({})
    })
    expect(fetchMock.mock.calls.filter(([path]: readonly unknown[]) => path === FILES_PATH)).toHaveLength(1)
    expect(texts(tree)).toContain('src/new.ts')
    // 紧凑行点击收起
    await act(async () => {
      tree.root.findByProps({ 'aria-expanded': true }).props.onClick({})
    })
    expect(collapsedRows()).toHaveLength(3)
  })

  it('悬停驻留弹出提交卡片，离开立即隐藏，移向卡片不隐藏；展开行同样弹出', async () => {
    vi.stubGlobal('fetch', stubFetch())
    vi.useFakeTimers()
    try {
      let tree!: ReactTestRenderer
      await act(async () => {
        tree = renderBody('/workspace')
      })
      const row = () =>
        tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] !== undefined)[0]!
      const enter = () =>
        row().props.onMouseEnter({
          currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) },
          clientX: 100,
        })
      await act(async () => {
        enter()
      })
      // 延时未到不弹卡片
      expect(texts(tree)).not.toContain('合并 feature 分支')
      // 悬停期间移动指针：卡片弹在最新指针位置（定位几何由 placeCard 单测覆盖）
      await act(async () => {
        row().props.onMouseMove({
          currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) },
          clientX: 300,
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      const card = texts(tree)
      expect(card).toContain('Li Lei')
      expect(card).toContain(formatRelative(1_700_000_100 * 1000))
      expect(card).toContain(formatTime(1_700_000_100 * 1000))
      expect(card).toContain('merge feature')
      expect(card).toContain('合并 feature 分支')
      expect(card).toContain(HEAD_HASH.slice(0, 7))
      expect(card).toContain(t('log.summary', { count: 4, added: 13, deleted: 3 }))
      // 离开行立即隐藏，无宽限定时
      await act(async () => {
        row().props.onMouseLeave({ relatedTarget: null })
      })
      expect(texts(tree)).not.toContain('合并 feature 分支')
      // 行移向卡片不隐藏：卡片可移入停留选中复制
      await act(async () => {
        enter()
      })
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      expect(texts(tree)).toContain('合并 feature 分支')
      await act(async () => {
        row().props.onMouseLeave({ relatedTarget: { closest: () => ({}) } })
      })
      expect(texts(tree)).toContain('合并 feature 分支')
      // 从卡片离开到别处：立即隐藏
      await act(async () => {
        tree.root.findByProps({ role: 'tooltip' }).props.onMouseLeave({ relatedTarget: null })
      })
      expect(texts(tree)).not.toContain('合并 feature 分支')
      // 从卡片移回本行：原样保留，无需重新驻留
      await act(async () => {
        enter()
      })
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      await act(async () => {
        tree.root
          .findByProps({ role: 'tooltip' })
          .props.onMouseLeave({ relatedTarget: { closest: () => ({}) } })
      })
      expect(texts(tree)).toContain('合并 feature 分支')
      // 展开行同样挂悬停入口：驻留后弹出卡片（用户已确认）
      await act(async () => {
        row().props.onClick({})
      })
      await act(async () => {
        enter()
      })
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      expect(texts(tree)).toContain('合并 feature 分支')
    } finally {
      vi.useRealTimers()
    }
  })

  it('卡片只属于一次驻留：换行立即收起并重新计时', async () => {
    vi.stubGlobal('fetch', stubFetch())
    vi.useFakeTimers()
    try {
      let tree!: ReactTestRenderer
      await act(async () => {
        tree = renderBody('/workspace')
      })
      const rows = () =>
        tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] !== undefined)
      const enter = (index: number) =>
        rows()[index]!.props.onMouseEnter({
          currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) },
          clientX: 100,
        })
      await act(async () => {
        enter(0)
      })
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      expect(texts(tree)).toContain('合并 feature 分支')
      // 换到另一行：立即收起旧卡片，而不是给它续命
      await act(async () => {
        rows()[0]!.props.onMouseLeave({ relatedTarget: null })
        enter(1)
      })
      expect(texts(tree)).not.toContain('合并 feature 分支')
      // 新行重新驻留：满 500ms 才弹出新行内容，不因旧卡片在场而提前
      await act(async () => {
        vi.advanceTimersByTime(120)
      })
      expect(texts(tree)).not.toContain('Han Meimei')
      await act(async () => {
        vi.advanceTimersByTime(380)
      })
      expect(texts(tree)).toContain('Han Meimei')
    } finally {
      vi.useRealTimers()
    }
  })

  it('悬停弹出延时可在插件详情页配置，改动即时生效', async () => {
    vi.stubGlobal('fetch', stubFetch())
    vi.useFakeTimers()
    try {
      setHoverDelay(1000)
      let tree!: ReactTestRenderer
      await act(async () => {
        tree = renderBody('/workspace')
      })
      const row = () =>
        tree.root.findAll((node: ReactTestInstance) => node.props['aria-expanded'] !== undefined)[0]!
      await act(async () => {
        row().props.onMouseEnter({
          currentTarget: { getBoundingClientRect: () => ({ top: 0, bottom: 100 }) },
          clientX: 100,
        })
      })
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      // 默认 500ms 已过，配置的 1000ms 未到：不弹
      expect(texts(tree)).not.toContain('合并 feature 分支')
      await act(async () => {
        vi.advanceTimersByTime(500)
      })
      expect(texts(tree)).toContain('合并 feature 分支')
    } finally {
      vi.useRealTimers()
      setHoverDelay(DEFAULT_HOVER_DELAY_MS)
    }
  })

  it('插件详情页配置面板：编辑后经保存写入共享 store，覆盖徽标与恢复默认，非法输入禁用保存', async () => {
    let tree!: ReactTestRenderer
    try {
      await act(async () => {
        tree = create(<ConfigSection {...({} as ComponentProps<typeof ConfigSection>)} t={t} />)
      })
      // id 同时出现在外层 SettingsValueField 与内层 input 上，须按元素类型过滤
      const input = () =>
        tree.root.findAll(
          (node: ReactTestInstance) => node.type === 'input' && node.props['id'] === 'dsh-git-hover-delay',
        )[0]!
      const buttonWith = (label: string) =>
        tree.root
          .findAll((node: ReactTestInstance) => node.type === 'button')
          .find((node) => node.props.children === label)!
      const save = () => buttonWith(t('config.save'))
      expect(input().props.value).toBe(String(DEFAULT_HOVER_DELAY_MS))
      expect(save().props.disabled).toBe(true)
      expect(texts(tree)).not.toContain(t('config.overridden'))
      // 编辑为 300（与默认不同）：保存前不落库，右上出现覆盖徽标与恢复默认
      await act(async () => {
        input().props.onChange({ target: { value: '300' } })
      })
      expect(getHoverDelay()).toBe(DEFAULT_HOVER_DELAY_MS)
      expect(texts(tree)).toContain(t('config.overridden'))
      expect(save().props.disabled).toBe(false)
      // 恢复默认：只暂存回默认值，保存禁用、徽标消失，store 未动
      await act(async () => {
        buttonWith(t('config.resetDefault')).props.onClick()
      })
      expect(input().props.value).toBe(String(DEFAULT_HOVER_DELAY_MS))
      expect(getHoverDelay()).toBe(DEFAULT_HOVER_DELAY_MS)
      expect(save().props.disabled).toBe(true)
      expect(texts(tree)).not.toContain(t('config.overridden'))
      // 重新编辑并保存：写入 store 并回显，已存值 ≠ 默认 → 徽标常驻
      await act(async () => {
        input().props.onChange({ target: { value: '300' } })
      })
      await act(async () => {
        save().props.onClick()
      })
      expect(getHoverDelay()).toBe(300)
      expect(input().props.value).toBe('300')
      expect(save().props.disabled).toBe(true)
      expect(texts(tree)).toContain(t('config.overridden'))
      // 越界输入：下方说明行换成错误信息（不额外加行），输入框标红，保存禁用，徽标消失
      await act(async () => {
        input().props.onChange({ target: { value: '9999' } })
      })
      expect(input().props['aria-invalid']).toBe(true)
      expect(texts(tree)).toContain(t('config.invalid'))
      expect(texts(tree)).not.toContain(t('config.hoverDelayHint'))
      expect(texts(tree)).not.toContain(t('config.overridden'))
      expect(save().props.disabled).toBe(true)
    } finally {
      setHoverDelay(DEFAULT_HOVER_DELAY_MS)
    }
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
