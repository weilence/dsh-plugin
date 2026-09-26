/**
 * 勾选清单：可复用的候选选择列表（Git 仓库扫描出的技能候选、MCP JSON
 * 解析出的服务器候选等）。行结构 = 最左垂直居中的 checkbox + 标题与
 * 元信息列；带 problem 的条目禁选并红字展示原因；清单超长时自身滚动
 * （上限取视口与固定值的较小者），操作按钮留在滚动区之外。
 */

import shared from './shared.module.css'

const styles = shared

/** 清单中的一行候选。 */
export interface PickItem {
  /** 勾选状态与列表项的稳定标识。 */
  key: string
  /** 主标题（等宽字体）。 */
  title: string
  /** 与标题同行、以「 · 」衔接的次要元信息。 */
  titleMeta?: string
  /** 正文行（次要色，逐行展示）。 */
  lines?: readonly string[]
  /** 附注行（更弱的次要色，如归一化 / 命名提示）。 */
  notes?: readonly string[]
  /** 存在即禁选并红字展示原因。 */
  problem?: string
}

export function PickList(props: {
  items: readonly PickItem[]
  picked: ReadonlySet<string>
  onToggle(key: string): void
}) {
  const { items, picked, onToggle } = props
  if (items.length === 0) return null
  return (
    <ul className={styles.pickList}>
      {items.map((item) => (
        <li key={item.key} className={styles.pickRow}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={picked.has(item.key)}
              disabled={item.problem !== undefined}
              onChange={() => onToggle(item.key)}
            />
            <span className={styles.pickMain}>
              <span className={styles.pickName}>
                {item.title}
                {item.titleMeta !== undefined ? (
                  <span className={styles.pickMeta}> · {item.titleMeta}</span>
                ) : null}
              </span>
              {(item.lines ?? []).map((line, index) => (
                <span key={index} className={styles.pickMeta}>
                  {line}
                </span>
              ))}
              {(item.notes ?? []).map((note, index) => (
                <span key={index} className={styles.pickNote}>
                  {note}
                </span>
              ))}
              {item.problem !== undefined ? <span className={styles.pickProblem}>{item.problem}</span> : null}
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
