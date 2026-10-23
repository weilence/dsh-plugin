import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { errMsg } from '@dsh-plugins/shared'
import type { GitCommitInfo, GitFileChange } from '../shared'
import type { CommitLayout } from './graph'
import { layoutLanes } from './graph'
import { readCommitFiles } from './api'
import type { GitT } from './locales'
import css from './CommitGraph.module.css'

const LANE_WIDTH = 14
const ROW_HEIGHT = 44
const DOT_RADIUS = 3.5
/** 泳道固定调色板（GitLens 风格的多色系）。 */
const LANE_COLORS = ['#4a9eff', '#ff7b72', '#3fb950', '#d29922', '#bc8cff', '#39c5cf', '#f778ba', '#8b949e']

const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]!

const laneX = (lane: number): number => lane * LANE_WIDTH + LANE_WIDTH / 2

function edgePath(from: number, to: number, y1: number, y2: number): string {
  const x1 = laneX(from)
  const x2 = laneX(to)
  if (from === to) return `M${x1},${y1}L${x1},${y2}`
  const mid = (y1 + y2) / 2
  return `M${x1},${y1}C${x1},${mid},${x2},${mid},${x2},${y2}`
}

/** 状态字母是 git 惯用记号（A/D/M/R），跨语言不翻译。 */
const STATUS_LETTER = { added: 'A', deleted: 'D', modified: 'M', renamed: 'R' } as const
const STATUS_CLASS = {
  added: css.statusAdded,
  deleted: css.statusDeleted,
  modified: css.statusModified,
  renamed: css.statusRenamed,
} as const

type FilesView =
  | { phase: 'loading' }
  | { phase: 'done'; files: readonly GitFileChange[] }
  | { phase: 'failed'; error: string }

function RefChips({ commit }: { commit: GitCommitInfo }) {
  return (
    <span className={css.chips}>
      {commit.branches.map((branch) => (
        <span
          key={branch}
          className={`${css.chip} ${branch === commit.headBranch ? css.chipHead : css.chipBranch}`}
        >
          {branch === commit.headBranch ? `HEAD → ${branch}` : branch}
        </span>
      ))}
      {commit.remotes.map((remote) => (
        <span key={remote} className={`${css.chip} ${css.chipRemote}`}>
          {remote}
        </span>
      ))}
      {commit.tags.map((tag) => (
        <span key={tag} className={`${css.chip} ${css.chipTag}`}>
          {tag}
        </span>
      ))}
    </span>
  )
}

function CommitFiles({ view, t }: { view: FilesView | undefined; t: GitT }) {
  if (view === undefined) return null
  if (view.phase === 'loading')
    return (
      <p className={css.filesNote} role="status">
        {t('log.filesLoading')}
      </p>
    )
  if (view.phase === 'failed')
    return (
      <p className={css.filesNote} role="alert">
        {view.error}
      </p>
    )
  if (view.files.length === 0) return <p className={css.filesNote}>{t('log.noFiles')}</p>
  return (
    <div className={css.filesBlock}>
      <span className={css.filesCount}>{t('log.files', { count: view.files.length })}</span>
      <ul className={css.files}>
        {view.files.map((file) => {
          const display = file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`
          return (
            <li key={`${file.status}:${file.path}`} className={css.file}>
              <span className={`${css.status} ${STATUS_CLASS[file.status]}`}>
                {STATUS_LETTER[file.status]}
              </span>
              <span className={css.filePath} title={display}>
                {display}
              </span>
              {file.added !== undefined && <span className={css.fileAdded}>{`+${file.added}`}</span>}
              {file.deleted !== undefined && <span className={css.fileDeleted}>{`-${file.deleted}`}</span>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/** 单行提交：strip 高度跟随内容列实测高度（取 max(常规行高)）。不能反过来观察
 *  行本身——strip 高度会撑住行高，收起详情时行尺寸不变、观察器不触发，高度回
 *  不去；内容列高度只由文本与详情决定，无反馈回路。穿越线与出边画到行底，与
 *  相邻行的连线保持连续；提交点恒锚在常规行高中点，与主题行对齐。 */
function CommitRow({
  commit,
  row,
  width,
  expanded,
  filesView,
  onToggleExpanded,
  t,
  formatTime,
}: {
  commit: GitCommitInfo
  row: CommitLayout
  width: number
  expanded: boolean
  filesView: FilesView | undefined
  onToggleExpanded: () => void
  t: GitT
  formatTime: (timestampMs: number) => string
}) {
  const mainRef = useRef<HTMLDivElement>(null)
  const [mainHeight, setMainHeight] = useState(ROW_HEIGHT)

  const measure = (): void => {
    const element = mainRef.current
    if (element === null || typeof element.getBoundingClientRect !== 'function') return
    const { height } = element.getBoundingClientRect()
    if (height > 0) setMainHeight(height)
  }

  // 展开/收起与文件区块到达必须在同一帧内量到新高度：ResizeObserver 回调里的
  // setState 走并发调度，绘制先于回调所在帧的更新，会先画一帧旧高度的连线（闪
  // 烁）。layout effect 同步跑在 DOM 变更后、绘制前，量到即落屏。
  useLayoutEffect(measure, [expanded, filesView?.phase])
  useLayoutEffect(() => {
    const element = mainRef.current
    if (element === null || typeof ResizeObserver === 'undefined') return
    // 兜底被动尺寸变化（面板变宽引发的文本换行）
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const height = Math.max(ROW_HEIGHT, mainHeight)
  const mid = ROW_HEIGHT / 2
  return (
    <li
      className={css.commit}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      data-expanded={expanded || undefined}
      onClick={(event) => {
        // 拖选行内文本（主题 / 提交号 / 邮箱 / 文件路径）松开时也派发 click，选中即
        // 切换会让选择刚完成就触发展开 / 收起——选区锚点在本行内的 click 只当选择
        const selection = window.getSelection()
        if (
          selection !== null &&
          !selection.isCollapsed &&
          selection.anchorNode !== null &&
          event.currentTarget.contains(selection.anchorNode)
        ) {
          return
        }
        onToggleExpanded()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onToggleExpanded()
        }
      }}
    >
      <svg className={css.strip} width={width} height={height} aria-hidden="true">
        {row.through.map((lane) => (
          <path
            key={`t${lane}`}
            d={edgePath(lane, lane, 0, height)}
            stroke={laneColor(lane)}
            strokeWidth="1.5"
            fill="none"
          />
        ))}
        {row.incoming.map((edge, i) => (
          <path
            key={`i${i}`}
            d={edgePath(edge.from, edge.to, 0, mid)}
            stroke={laneColor(edge.from)}
            strokeWidth="1.5"
            fill="none"
          />
        ))}
        {row.outgoing.map((edge, i) => (
          <path
            key={`o${i}`}
            d={edgePath(edge.from, edge.to, mid, height)}
            stroke={laneColor(edge.to)}
            strokeWidth="1.5"
            fill="none"
          />
        ))}
        <circle cx={laneX(row.lane)} cy={mid} r={DOT_RADIUS} fill={laneColor(row.lane)} />
      </svg>
      <div ref={mainRef} className={css.main}>
        <div className={css.line1}>
          <RefChips commit={commit} />
          <span className={css.subject} title={commit.subject}>
            {commit.subject}
          </span>
        </div>
        <div className={css.line2}>
          <span className={css.author}>{commit.authorName}</span>
          <span className={css.time}>{formatTime(commit.timestamp * 1000)}</span>
        </div>
        {expanded && (
          <div className={css.detail}>
            <span className={css.hash}>{commit.hash}</span>
            <span className={css.email}>{commit.authorEmail}</span>
            <CommitFiles view={filesView} t={t} />
          </div>
        )}
      </div>
    </li>
  )
}

/** 泳道提交图：每行一段 SVG strip（穿越竖线 + 进出弧线 + 提交点）加文本列；展开的
 *  提交按需读取文件变更并缓存（失败可重试，切换仓库清空）。 */
export function CommitGraph({
  repo,
  commits,
  truncated,
  t,
  formatTime,
}: {
  repo: string
  commits: readonly GitCommitInfo[]
  truncated: boolean
  t: GitT
  formatTime: (timestampMs: number) => string
}) {
  const layout = useMemo(() => layoutLanes(commits), [commits])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesCache, setFilesCache] = useState<ReadonlyMap<string, FilesView>>(new Map())
  const requested = useRef<ReadonlySet<string>>(new Set())
  const width = layout.laneCount * LANE_WIDTH

  // 请求过的哈希记在 ref：缓存写入不重触发拉取，收起再展开直接命中缓存
  useEffect(() => {
    if (expanded === null || requested.current.has(expanded)) return
    requested.current = new Set(requested.current).add(expanded)
    const controller = new AbortController()
    setFilesCache((cache) => new Map(cache).set(expanded, { phase: 'loading' }))
    readCommitFiles(repo, expanded, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setFilesCache((cache) => new Map(cache).set(expanded, { phase: 'done', files: result.files }))
      })
      .catch((error: unknown) => {
        // 失败不驻留缓存，重新展开即重试
        requested.current = new Set([...requested.current].filter((hash) => hash !== expanded))
        if (controller.signal.aborted) return
        setFilesCache((cache) => new Map(cache).set(expanded, { phase: 'failed', error: errMsg(error) }))
      })
    return () => controller.abort()
  }, [expanded, repo])

  useEffect(() => {
    requested.current = new Set()
    setFilesCache(new Map())
  }, [repo])

  return (
    <div className={css.wrap}>
      <ul className={css.commits}>
        {commits.map((commit, index) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            row={layout.rows[index]!}
            width={width}
            expanded={expanded === commit.hash}
            filesView={expanded === commit.hash ? filesCache.get(commit.hash) : undefined}
            onToggleExpanded={() => setExpanded(expanded === commit.hash ? null : commit.hash)}
            t={t}
            formatTime={formatTime}
          />
        ))}
      </ul>
      <footer className={css.footer}>
        <span>{t('log.count', { count: commits.length })}</span>
        {truncated ? <span>{t('log.truncated')}</span> : null}
      </footer>
    </div>
  )
}
