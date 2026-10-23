import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { errMsg } from '@dsh-plugins/shared'
import type { GitCommitInfo, GitFileChange } from '../shared'
import type { CommitLayout } from './graph'
import { layoutLanes, placeCard, ROW_HEIGHT, rowAnchorSpan } from './graph'
import { readCommitFiles } from './api'
import type { GitT } from './locales'
import css from './CommitGraph.module.css'

const LANE_WIDTH = 14
const DOT_RADIUS = 3.5

/** 悬停卡片的 portal 目标：卡片是视口级 fixed 覆盖面，必须挂在 body——留在面板
 *  树内会被 dock 泳道单元的 z-10 层叠上下文封顶，宿主在侧栏左缘的隐形拖拽把手
 *  （8px 全高命中条，z-11，刻意压在右栏之上）会截走侧栏边界上的命中，指针跨过
 *  即触发卡片 mouseleave 整卡收起。挂 body 后以自身 z-index 参与顶层层序（层表
 *  见 CommitGraph.module.css 的 .card）。无 DOM 环境（node 单测）降级原位渲染。 */
const portalTarget = typeof document === 'undefined' ? null : document.body

/** 悬停卡片锚点：触发弹出时的指针 x 与所在行缘（卡片贴行缘、横向对齐指针）。 */
interface HoverAnchor {
  commit: GitCommitInfo
  pointerX: number
  rowTop: number
  rowBottom: number
}

/** 行上悬停指针事件的最小切片（指针 x 与所在行缘）。 */
interface HoverPointerEvent {
  currentTarget: { getBoundingClientRect: () => { top: number; bottom: number } }
  clientX: number
}

/** 指针是否落在展开详情区（refs 芯片 / 文件清单）：该区域不属于行驻留（用户已确认）。 */
const overDetail = (event: { target?: EventTarget | null }): boolean => {
  const target = event.target as Element | null | undefined
  return target !== undefined && target !== null && target.closest('[data-detail]') !== null
}
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
  if (commit.branches.length === 0 && commit.remotes.length === 0 && commit.tags.length === 0) {
    return null
  }
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
 *  不去；内容列高度只由文本与详情决定，无反馈回路。穿越线全程直线；出边曲线
 *  固定在常规行高内完成转向，展开区只延伸竖直直线到行底，与相邻行的连线保持
 *  连续——展开不拉伸曲线；提交点恒锚在常规行高中点，与主题行对齐。 */
function CommitRow({
  commit,
  row,
  width,
  expanded,
  filesView,
  showMeta,
  onToggleExpanded,
  onHoverStart,
  onHoverMove,
  onHoverLeave,
  t,
  formatTime,
}: {
  commit: GitCommitInfo
  row: CommitLayout
  width: number
  expanded: boolean
  filesView: FilesView | undefined
  showMeta: boolean
  onToggleExpanded: () => void
  onHoverStart: (event: HoverPointerEvent) => void
  onHoverMove: (event: HoverPointerEvent) => void
  onHoverLeave: () => void
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
      data-hash={commit.hash}
      onClick={(event) => {
        // 展开的详情区（refs 芯片 / 文件变更清单，data-detail 标记）点击完全不参
        // 与切换——那里是查阅与滚动的区域；收起只由紧凑行的点击与键盘承担
        const target = event.target as Element | null | undefined
        if (target !== undefined && target !== null && target.closest('[data-detail]') !== null) return
        onToggleExpanded()
      }}
      onMouseEnter={(event) => {
        // 从相邻行直接进入展开详情不算进入行：详情区不属于行驻留，不驻留
        if (overDetail(event)) return
        onHoverStart(event)
      }}
      onMouseMove={(event) => {
        // 移入展开详情等同离开（用户已确认）：立即收起；锚点跟踪与重新驻留只
        // 发生在紧凑行上
        if (overDetail(event)) {
          onHoverLeave()
          return
        }
        onHoverMove(event)
      }}
      onMouseLeave={(event) => {
        // 离开立即隐藏（用户已确认，无宽限）：relatedTarget 指向悬停卡片时不隐藏，
        // 卡片可移入选中复制；其余去向（换行 / 离窗）立即收起
        const next = event.relatedTarget as Element | null
        if (next !== null && next.closest('[data-hover-card]') !== null) return
        onHoverLeave()
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
          <Fragment key={`o${i}`}>
            {/* 出边曲线固定在常规行高内完成转向（与普通行一致），展开撑出的高度
                只以竖直直线延伸到行底——展开不把曲线拉伸开 */}
            <path
              d={edgePath(edge.from, edge.to, mid, ROW_HEIGHT)}
              stroke={laneColor(edge.to)}
              strokeWidth="1.5"
              fill="none"
            />
            {height > ROW_HEIGHT && (
              <path
                d={`M${laneX(edge.to)},${ROW_HEIGHT}L${laneX(edge.to)},${height}`}
                stroke={laneColor(edge.to)}
                strokeWidth="1.5"
                fill="none"
              />
            )}
          </Fragment>
        ))}
        <circle cx={laneX(row.lane)} cy={mid} r={DOT_RADIUS} fill={laneColor(row.lane)} />
      </svg>
      <div ref={mainRef} className={css.main}>
        <div className={css.line}>
          {/* 不挂原生 title：悬停有提交卡片，原生提示会与之重复 */}
          <span className={css.subject}>{commit.subject}</span>
          {showMeta && (
            <>
              <span className={css.author}>{commit.authorName}</span>
              <span className={css.time}>{formatTime(commit.timestamp * 1000)}</span>
            </>
          )}
        </div>
        {expanded && (
          <div className={css.detail} data-detail="">
            <RefChips commit={commit} />
            <CommitFiles view={filesView} t={t} />
          </div>
        )}
      </div>
    </li>
  )
}

/** 泳道提交图：每行一段 SVG strip（穿越竖线 + 进出弧线 + 提交点）加文本列；展开与
 *  悬停按需读取文件变更并缓存（失败可重试，切换仓库清空）；悬停行驻留可配置延时
 *  后在行缘之外紧贴行弹出提交卡片（作者、相对 / 绝对时间、主题、正文、变更统计、
 *  短提交号，横向对齐指针，放不下自动翻面）；卡片经 portal 挂 body——视口级覆盖面
 *  须脱离面板树的层叠上下文，可移入并选中复制；卡片只属于一次驻留——换到另一行
 *  立即收起并重新驻留，离开行与卡片、点击切换、滚动即隐藏。 */
export function CommitGraph({
  repo,
  commits,
  truncated,
  showMeta,
  hoverDelayMs,
  t,
  formatTime,
  formatRelative,
}: {
  repo: string
  commits: readonly GitCommitInfo[]
  truncated: boolean
  showMeta: boolean
  hoverDelayMs: number
  t: GitT
  formatTime: (timestampMs: number) => string
  formatRelative: (timestampMs: number) => string
}) {
  const layout = useMemo(() => layoutLanes(commits), [commits])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [filesCache, setFilesCache] = useState<ReadonlyMap<string, FilesView>>(new Map())
  const requested = useRef<ReadonlySet<string>>(new Set())
  const [hover, setHover] = useState<HoverAnchor | null>(null)
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null)
  const cardRef = useRef<HTMLDivElement | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerRef = useRef<{ x: number; rowTop: number; rowBottom: number }>({
    x: 0,
    rowTop: 0,
    rowBottom: 0,
  })
  const width = layout.laneCount * LANE_WIDTH

  // 卡片渲染后同步量实际尺寸、行缘贴合定位：layout effect 跑在绘制前，无闪动。
  // 纵向贴行底（放不下贴行顶），横向对齐指针 x（placeCard 纯函数）。
  useLayoutEffect(() => {
    if (hover === null) {
      setCardPos(null)
      return
    }
    const element = cardRef.current
    if (element === null) return
    setCardPos(
      placeCard(
        hover.pointerX,
        hover.rowTop,
        hover.rowBottom,
        element.offsetWidth,
        element.offsetHeight,
        window.innerWidth,
        window.innerHeight,
      ),
    )
  }, [hover])

  // 立即收起卡片并中止未触发的弹出（用户已确认：离开立即隐藏，无宽限定时）。
  // 「移向卡片 / 移回本行不隐藏」由行与卡片的 onMouseLeave 以 relatedTarget 判向。
  const cancelHover = (): void => {
    if (hoverTimer.current !== null) {
      clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
    setHover(null)
  }

  useEffect(() => cancelHover, [])

  // 展开与悬停共用同一份按需缓存：悬停半秒即触发拉取，点击展开时多半已就绪
  const activeHash = expanded ?? hover?.commit.hash ?? null
  useEffect(() => {
    if (activeHash === null || requested.current.has(activeHash)) return
    requested.current = new Set(requested.current).add(activeHash)
    const controller = new AbortController()
    setFilesCache((cache) => new Map(cache).set(activeHash, { phase: 'loading' }))
    readCommitFiles(repo, activeHash, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return
        setFilesCache((cache) => new Map(cache).set(activeHash, { phase: 'done', files: result.files }))
      })
      .catch((error: unknown) => {
        // 失败不驻留缓存，重新展开 / 悬停即重试
        requested.current = new Set([...requested.current].filter((hash) => hash !== activeHash))
        if (controller.signal.aborted) return
        setFilesCache((cache) => new Map(cache).set(activeHash, { phase: 'failed', error: errMsg(error) }))
      })
    return () => controller.abort()
  }, [activeHash, repo])

  useEffect(() => {
    requested.current = new Set()
    setFilesCache(new Map())
  }, [repo])

  // 卡片只属于一次驻留（用户已确认），mouseenter 与 mousemove 共用本调度：同行
  // 已有卡片原样保留（不重置计时、不挪锚点）；驻留进行中只跟踪锚点——mousemove
  // 高频触发，重置计时会让弹出永不到来；其余（换行 / 驻留被取消后行内移动）一
  // 律先收再驻、重新计时，不依赖离开 / 进入两次事件间的渲染刷新。锚点行缘只取
  // 紧凑行（rowAnchorSpan）——卡片贴选中行底，不贴展开详情之下的整行底。
  const scheduleHover = (commit: GitCommitInfo, event: HoverPointerEvent): void => {
    pointerRef.current = {
      x: event.clientX,
      ...rowAnchorSpan(event.currentTarget.getBoundingClientRect().top),
    }
    if (hover !== null && hover.commit.hash === commit.hash) return
    if (hoverTimer.current !== null) return
    cancelHover()
    hoverTimer.current = setTimeout(() => {
      hoverTimer.current = null
      setHover({
        commit,
        pointerX: pointerRef.current.x,
        rowTop: pointerRef.current.rowTop,
        rowBottom: pointerRef.current.rowBottom,
      })
    }, hoverDelayMs)
  }

  const toggle = (hash: string): void => {
    cancelHover()
    setExpanded((current) => (current === hash ? null : hash))
  }

  const hoverFiles = hover === null ? undefined : filesCache.get(hover.commit.hash)
  const hoverBody = hover === null ? '' : (hover.commit.body ?? '')
  const hoverSummary =
    hoverFiles?.phase === 'done'
      ? {
          count: hoverFiles.files.length,
          added: hoverFiles.files.reduce((total, file) => total + (file.added ?? 0), 0),
          deleted: hoverFiles.files.reduce((total, file) => total + (file.deleted ?? 0), 0),
        }
      : null

  const card =
    hover === null ? null : (
      <div
        ref={cardRef}
        className={css.card}
        style={cardPos ?? { visibility: 'hidden' }}
        role="tooltip"
        data-hover-card=""
        onMouseLeave={(event) => {
          // 移回本行不隐藏（行上悬停原样保留），其余离开立即隐藏
          const next = event.relatedTarget as Element | null
          if (next !== null && next.closest(`[data-hash="${hover.commit.hash}"]`) !== null) return
          cancelHover()
        }}
      >
        <p className={css.cardHead}>
          <span className={css.cardAuthor}>{hover.commit.authorName}</span>
          <span className={css.cardTime}>
            {formatRelative(hover.commit.timestamp * 1000)} ({formatTime(hover.commit.timestamp * 1000)})
          </span>
        </p>
        <p className={css.cardSubject}>{hover.commit.subject}</p>
        {/* host half 未重启的升级窗口内 body 字段可能缺席 */}
        {hoverBody.length > 0 && <p className={css.cardBody}>{hoverBody}</p>}
        {hoverSummary !== null && hoverSummary.count > 0 && (
          <p className={css.cardSummary}>
            {t('log.summary', {
              count: hoverSummary.count,
              added: hoverSummary.added,
              deleted: hoverSummary.deleted,
            })}
          </p>
        )}
        <p className={css.cardHash}>{hover.commit.hash.slice(0, 7)}</p>
      </div>
    )

  return (
    <div className={css.wrap}>
      <ul className={css.commits} onScroll={cancelHover}>
        {commits.map((commit, index) => (
          <CommitRow
            key={commit.hash}
            commit={commit}
            row={layout.rows[index]!}
            width={width}
            expanded={expanded === commit.hash}
            filesView={expanded === commit.hash ? filesCache.get(commit.hash) : undefined}
            showMeta={showMeta}
            onToggleExpanded={() => toggle(commit.hash)}
            onHoverStart={(event) => scheduleHover(commit, event)}
            onHoverMove={(event) => scheduleHover(commit, event)}
            onHoverLeave={cancelHover}
            t={t}
            formatTime={formatTime}
          />
        ))}
      </ul>
      <footer className={css.footer}>
        <span>{t('log.count', { count: commits.length })}</span>
        {truncated ? <span>{t('log.truncated')}</span> : null}
      </footer>
      {/* 视口级覆盖面挂 body（缘由见 portalTarget 注释）；原位渲染只出现在无 DOM 的测试环境 */}
      {card !== null && (portalTarget !== null ? createPortal(card, portalTarget) : card)}
    </div>
  )
}
