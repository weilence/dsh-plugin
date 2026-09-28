import type { ReactNode } from 'react'
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { RowDragHandlers } from './drag'
import { Pill, type PillData } from './Pill'
import shared from './shared.module.css'
import styles from './ExpandableCard.module.css'

export interface ExpandableCardInfoItem {
  label: string
  value: ReactNode
}

/**
 * 可展开卡片行：收起 layer-3 底 / border-l4，展开 layer-2 底 / label-dimmed
 * 边框；整行可点展开，动作区阻止冒泡；行头可拖拽（dragHandlers）。
 * 首个消费者是 dsh-models 的 provider 列表与模型清单。
 */
export interface ExpandableCardProps {
  open: boolean
  onToggle(): void
  /** 标题行主文本。 */
  title: ReactNode
  /** 标题行次级文本（id，code 字形）。 */
  meta?: ReactNode
  /** 标题行主文本后的附加标记（徽标）。 */
  badge?: ReactNode
  /** 标题行上的状态 pill 组。 */
  pills?: readonly PillData[]
  /** 标题行下的描述行（端点等，普通字重）。 */
  description?: ReactNode
  /** 次级说明行（适用时机等，弱化色）。 */
  note?: ReactNode
  /** 错误行（错误色，最多两行截断）。 */
  error?: string
  /** 行头的 label / value 信息项，空缺省不渲染。 */
  info?: readonly ExpandableCardInfoItem[]
  /** 等宽字体的路径行（patch id 等，超出省略）。 */
  path?: ReactNode
  /** 行头右侧动作区（阻止冒泡，不触发展开）。 */
  actions?: ReactNode
  /** 行头与展开体之间的整卡提示行。 */
  notice?: ReactNode
  /** 展开体；长清单需内部滚动时同时给 scrollBody。 */
  children?: ReactNode
  scrollBody?: boolean
  ariaLabel?: string
  dragging?: boolean
  dropLine?: 'top' | 'bottom' | null
  /** 行拖拽属性：start / end 在行头，over / drop 在整卡（不传即不可拖）。 */
  dragHandlers?: RowDragHandlers
}

export function ExpandableCard(props: ExpandableCardProps) {
  const { dragHandlers } = props
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
      {/* 整行可点击展开，动作区域阻止冒泡；对齐官方 settings 卡片布局。 */}
      <header
        className={styles.head}
        role="button"
        tabIndex={0}
        aria-expanded={props.open}
        aria-label={props.ariaLabel}
        draggable={dragHandlers?.draggable}
        onDragStart={dragHandlers?.onDragStart}
        onDragEnd={dragHandlers?.onDragEnd}
        onClick={props.onToggle}
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
              <span className={styles.meta}>{props.meta}</span>
            ) : null}
          </span>
          {props.description !== undefined ? <p className={shared.rowDesc}>{props.description}</p> : null}
          {props.note !== undefined ? <p className={shared.rowWhen}>{props.note}</p> : null}
          {props.error !== undefined && props.error.length > 0 ? (
            <p className={shared.rowErrText} title={props.error}>
              {props.error}
            </p>
          ) : null}
          {props.info !== undefined && props.info.length > 0 ? (
            <div className={styles.info}>
              {props.info.map((item) => (
                <span className={styles.infoItem} key={item.label}>
                  <span className={styles.infoLabel}>{item.label}</span>
                  <span className={styles.infoValue}>{item.value}</span>
                </span>
              ))}
            </div>
          ) : null}
          {props.path !== undefined ? <p className={shared.rowPath}>{props.path}</p> : null}
        </div>
        {props.actions !== undefined ? (
          <div className={styles.actions} onClick={(event) => event.stopPropagation()}>
            {props.actions}
          </div>
        ) : null}
        {/* 展开指示箭头（官方 .chevron / .chevronOpen 同款）：朝下 = 收起，展开旋转 180°。 */}
        <span className={props.open ? `${styles.caret} ${styles.caretOpen}` : styles.caret}>
          <IconChevronDownOutlineRegular />
        </span>
      </header>
      {props.notice}
      {props.open ? (
        <div className={props.scrollBody === true ? `${styles.body} ${styles.bodyScroll}` : styles.body}>
          {props.children}
        </div>
      ) : null}
    </section>
  )
}
