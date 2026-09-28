import type { ReactNode, Ref } from 'react'
import { ExpandableCard, type ExpandableCardProps } from './ExpandableCard'
import { useRowDragReorder } from './drag'
import styles from './shared.module.css'

type CardContent = Omit<ExpandableCardProps, 'dragging' | 'dropLine' | 'dragHandlers'>

export interface CardListProps<T> {
  items: readonly T[]
  getKey(item: T): string
  renderCard(item: T): CardContent
  onReorder?(from: number, to: number): void
  canDrag?(item: T): boolean
  toolbar?: ReactNode
  before?: ReactNode
  after?: ReactNode
  empty?: ReactNode
  listRef?: Ref<HTMLDivElement>
}

export function CardList<T>(props: CardListProps<T>) {
  const drag = useRowDragReorder(props.onReorder, props.items.map(props.getKey))
  return (
    <>
      {props.toolbar !== undefined ? <div className={styles.listToolbar}>{props.toolbar}</div> : null}
      <div className={styles.rows} ref={props.listRef}>
        {props.before}
        {props.items.map((item, index) => {
          const key = props.getKey(item)
          return (
            <ExpandableCard
              {...props.renderCard(item)}
              key={key}
              dragging={drag.isDragging(index)}
              dropLine={drag.lineAt(index, props.items.length)}
              dragHandlers={
                props.onReorder !== undefined && (props.canDrag === undefined || props.canDrag(item))
                  ? drag.rowProps(index, key)
                  : undefined
              }
            />
          )
        })}
        {props.items.length === 0 ? props.empty : null}
        {props.after}
      </div>
    </>
  )
}
