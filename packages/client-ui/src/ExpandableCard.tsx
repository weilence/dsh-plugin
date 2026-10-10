import { useState, type ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RowDragHandlers } from './drag'
import { Dialog } from './Dialog'
import { Pill, type PillData } from './Pill'
import shared from './shared.module.css'
import styles from './ExpandableCard.module.css'

export interface ExpandableCardInfoItem {
  label: string
  value: ReactNode
}

/** 错误详情弹窗素材：全文与文案（共享组件不内嵌文案，由调用方传入）。 */
export interface ExpandableCardErrorDetail {
  /** 完整错误输出（多行原文）。 */
  text: string
  title: string
  expandLabel: string
  closeLabel: string
}

/** 错误详情弹窗：错误行「查看完整」打开的内容（ExpandableCard 内部挂载）。 */
export function ErrorDetailDialog(props: ExpandableCardErrorDetail & { onClose(): void }) {
  return (
    <Dialog title={props.title} closeLabel={props.closeLabel} onClose={props.onClose}>
      <pre className={shared.errorPre}>{props.text}</pre>
    </Dialog>
  )
}

/**
 * 可展开卡片行：整行可点展开、行头可拖拽（dragHandlers）；标题行各文本区
 * （meta / 描述 / 信息值 / 路径）带 data-drag-skip 参与按下手势仲裁。
 */
export interface ExpandableCardProps {
  open: boolean
  onToggle(): void
  title: ReactNode
  meta?: ReactNode
  badge?: ReactNode
  pills?: readonly PillData[]
  description?: ReactNode
  note?: ReactNode
  /** 错误行（错误色，最多两行截断）。 */
  error?: string
  /** 错误行的完整详情（传入即获得「查看完整」弹窗机制；不传则行为不变）。 */
  errorDetail?: ExpandableCardErrorDetail
  info?: readonly ExpandableCardInfoItem[]
  path?: ReactNode
  /** 行头右侧动作区（阻止冒泡，不触发展开）。 */
  actions?: ReactNode
  children?: ReactNode
  dragging?: boolean
  dropLine?: 'top' | 'bottom' | null
  /** 行拖拽属性：start / end 在行头，over / drop 在整卡（不传即不可拖）。 */
  dragHandlers?: RowDragHandlers
}

export function ExpandableCard(props: ExpandableCardProps) {
  const { dragHandlers } = props
  // 手势仲裁：draggable 行头上浏览器拖拽优先于划选。按下点在可选值行
  // （data-drag-skip 标记的 meta / 描述 / 信息值 / 路径）上时本次手势禁用
  // draggable 让位给划选；mousedown 的同步 flush 保证属性在拖拽阈值前
  // 已落 DOM，从行头其余区域按下照常拖拽。
  const [dragArmed, setDragArmed] = useState(true)
  const [errorDetailOpen, setErrorDetailOpen] = useState(false)
  return (
    <section
      className={[
        styles.card,
        props.open ? styles.cardOpen : '',
        props.dropLine === 'top' ? styles.lineTop : '',
        props.dropLine === 'bottom' ? styles.lineBottom : '',
        props.dragging ? styles.cardDragging : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onDragOver={dragHandlers?.onDragOver}
      onDrop={dragHandlers?.onDrop}
    >
      <header
        className={styles.head}
        role="button"
        tabIndex={0}
        aria-expanded={props.open}
        draggable={dragHandlers?.draggable === true && dragArmed}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={() => {
          setDragArmed(true)
          dragHandlers?.onDragEnd?.()
        }}
        onMouseDown={(event) => {
          setDragArmed((event.target as Element).closest('[data-drag-skip]') === null)
        }}
        onMouseUp={() => setDragArmed(true)}
        onClick={(event) => {
          // 拖选行内文本（描述行 URL 等）松开时也派发 click，选中即收起/展开
          // 会让选择刚完成就触发展开/收起——选区锚点在本行头内的 click 只当选择，不触发展开。
          const selection = window.getSelection()
          if (
            selection !== null &&
            !selection.isCollapsed &&
            selection.anchorNode !== null &&
            event.currentTarget.contains(selection.anchorNode)
          ) {
            return
          }
          props.onToggle()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            props.onToggle()
          }
        }}
      >
        <div className={styles.headMain}>
          <span className={styles.titleRow}>
            <span className={styles.title}>{props.title}</span>
            {props.badge}
            {props.pills?.map((pill, index) => (
              <Pill key={index} text={pill.text} tone={pill.tone} title={pill.title} />
            ))}
            {props.meta !== undefined && props.meta !== '' ? (
              <span className={styles.meta} data-drag-skip>
                {props.meta}
              </span>
            ) : null}
          </span>
          {props.description !== undefined ? (
            <p className={shared.rowDesc} data-drag-skip>
              {props.description}
            </p>
          ) : null}
          {props.note !== undefined ? <p className={shared.rowWhen}>{props.note}</p> : null}
          {props.error !== undefined && props.error.length > 0 ? (
            <div className={shared.rowErr}>
              <p className={shared.rowErrText} title={props.error} data-drag-skip>
                {props.error}
              </p>
              {props.errorDetail !== undefined ? (
                <button
                  type="button"
                  className={shared.rowErrMore}
                  onClick={(event) => {
                    // 入口点击只开弹窗，不触发行展开 / 收起
                    event.stopPropagation()
                    setErrorDetailOpen(true)
                  }}
                >
                  {props.errorDetail.expandLabel}
                </button>
              ) : null}
            </div>
          ) : null}
          {props.info !== undefined && props.info.length > 0 ? (
            <div className={styles.info}>
              {props.info.map((item) => (
                <span className={styles.infoItem} key={item.label} data-drag-skip>
                  <span className={styles.infoLabel}>{item.label}</span>
                  <span className={styles.infoValue}>{item.value}</span>
                </span>
              ))}
            </div>
          ) : null}
          {props.path !== undefined ? (
            <p className={shared.rowPath} data-drag-skip>
              {props.path}
            </p>
          ) : null}
        </div>
        {props.actions !== undefined ? (
          <div className={styles.actions} onClick={(event) => event.stopPropagation()}>
            {props.actions}
          </div>
        ) : null}
        {/* 与官方 .chevron / .chevronOpen 一致的指示箭头 */}
        <span className={props.open ? `${styles.caret} ${styles.caretOpen}` : styles.caret}>
          <IconChevronDownOutlineRegular />
        </span>
      </header>
      {props.open ? <div className={styles.body}>{props.children}</div> : null}
      {errorDetailOpen && props.errorDetail !== undefined ? (
        <ErrorDetailDialog {...props.errorDetail} onClose={() => setErrorDetailOpen(false)} />
      ) : null}
    </section>
  )
}
