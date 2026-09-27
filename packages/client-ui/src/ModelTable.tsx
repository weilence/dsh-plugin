import { Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { formatTokenCount } from './format'
import styles from './ModelTable.module.css'

export interface ModelTableRowData {
  name: string
  id: string
  badge?: string
  ctx?: number
  out?: number
  input?: readonly string[]
  reasoning: string
}

export interface ModelTableProps {
  rows: readonly ModelTableRowData[]
}

/** 只读模型清单表（无表头）：名称 + ID / ctx·out / 模态·推理 三列，
 *  单元格内两行堆叠，跨行按列对齐；无 hover 效果。 */
export function ModelTable(props: ModelTableProps) {
  return (
    <table className={styles.modelTable}>
      <tbody>
        {props.rows.map((row) => (
          <tr key={row.id} className={styles.model}>
            <td className={styles.modelCell}>
              <span className={styles.modelNameRow}>
                <span className={styles.modelName}>{row.name}</span>
                {row.badge ? <Tag>{row.badge}</Tag> : null}
              </span>
              <span className={styles.modelId}>{row.id}</span>
            </td>
            <td className={styles.modelMetrics}>
              <span>{row.ctx === undefined ? 'ctx —' : `ctx ${formatTokenCount(row.ctx)}`}</span>
              <span>{row.out === undefined ? 'out —' : `out ${formatTokenCount(row.out)}`}</span>
            </td>
            <td className={styles.modelMetrics}>
              <span>{row.input === undefined || row.input.length === 0 ? '—' : row.input.join('+')}</span>
              <span>{row.reasoning}</span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
