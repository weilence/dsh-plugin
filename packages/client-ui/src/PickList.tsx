import shared from './shared.module.css'
import { ToneChip } from './tone'

/** 清单中的一行候选。 */
export interface PickItem {
  key: string
  title: string
  /** 与标题同行、以「 · 」衔接的次要元信息。 */
  titleMeta?: string
  lines?: readonly string[]
  /** 更弱化色的附注行（归一化 / 命名提示等）。 */
  notes?: readonly string[]
  /** 存在即禁选并红字展示原因。 */
  problem?: string
  /** 勾选锁定：渲染为已勾选 + 不可切换（正常配色，区别于 problem 的红字禁选）；
   *  picked 集合里应恒含此 key。 */
  locked?: boolean
  /** 行尾的 ok 色调状态徽标（如「已一致」）——醒目于普通元信息文字。 */
  tag?: string
}

export function PickList(props: {
  items: readonly PickItem[]
  picked: ReadonlySet<string>
  onToggle(key: string): void
}) {
  const { items, picked, onToggle } = props
  if (items.length === 0) return null
  return (
    <ul className={shared.pickList}>
      {items.map((item) => (
        <li key={item.key} className={shared.pickRow}>
          <label className={shared.check}>
            <input
              type="checkbox"
              checked={picked.has(item.key)}
              disabled={item.locked === true || item.problem !== undefined}
              onChange={() => onToggle(item.key)}
            />
            <span className={shared.pickMain}>
              <span className={shared.pickName}>
                {item.title}
                {item.titleMeta !== undefined ? (
                  <span className={shared.pickMeta}> · {item.titleMeta}</span>
                ) : null}
              </span>
              {(item.lines ?? []).map((line, index) => (
                <span key={index} className={shared.pickMeta}>
                  {line}
                </span>
              ))}
              {(item.notes ?? []).map((note, index) => (
                <span key={index} className={shared.pickNote}>
                  {note}
                </span>
              ))}
              {item.problem !== undefined ? <span className={shared.pickProblem}>{item.problem}</span> : null}
              {item.tag !== undefined ? <ToneChip tone="ok">{item.tag}</ToneChip> : null}
            </span>
          </label>
        </li>
      ))}
    </ul>
  )
}
