import type { ReactNode } from 'react'
import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { useRowDragReorder } from './drag'
import styles from './ModelTable.module.css'

function fmtCount(value: number) {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}

export interface ModelTableRowData {
  key: string
  name: string
  id: string
  badge?: string
  ctx?: number
  out?: number
  input?: readonly string[]
  reasoning: string
  onClick?(): void
  actions?: ReactNode
}

export interface ModelTableProps {
  rows: readonly ModelTableRowData[]
  /** 提供后行可拖拽排序（仅对模型清单有序的 route 有意义）。 */
  onReorder?(from: number, to: number): void
}

export function ModelTable(props: ModelTableProps) {
  const drag = useRowDragReorder(props.onReorder)
  const hasActions = props.rows.some((row) => row.actions !== undefined)
  return (
    <table className={styles.modelTable}>
      <tbody>
        {props.rows.map((row, index) => {
          const classNames = [styles.model]
          if (row.onClick !== undefined) classNames.push(styles.modelRowClickable)
          if (drag.isDragging(index)) classNames.push(styles.modelDragging)
          const line = drag.lineAt(index, props.rows.length)
          if (line === 'top') classNames.push(styles.modelLineTop)
          if (line === 'bottom') classNames.push(styles.modelLineBottom)
          return (
            <tr
              key={row.key}
              className={classNames.join(' ') || undefined}
              {...drag.rowProps(index, row.key)}
              onClick={row.onClick}
            >
              <td className={styles.modelCell}>
                <span className={styles.modelNameRow}>
                  <span className={styles.modelName}>{row.name}</span>
                  {row.badge ? <Tag>{row.badge}</Tag> : null}
                </span>
                <span className={styles.modelId}>{row.id}</span>
              </td>
              <td className={styles.modelMetrics}>
                <span>{row.ctx === undefined ? 'ctx —' : `ctx ${fmtCount(row.ctx)}`}</span>
                <span>{row.out === undefined ? 'out —' : `out ${fmtCount(row.out)}`}</span>
              </td>
              <td className={styles.modelMetrics}>
                <span>{row.input === undefined || row.input.length === 0 ? '—' : row.input.join('+')}</span>
                <span>{row.reasoning}</span>
              </td>
              {hasActions ? (
                <td className={styles.modelRowActions} onClick={(event) => event.stopPropagation()}>
                  {row.actions}
                </td>
              ) : null}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
