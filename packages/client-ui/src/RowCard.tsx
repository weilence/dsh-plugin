import type { ReactNode } from 'react'
import { Pill, type PillData } from './Pill'
import shared from './shared.module.css'

/** 行卡片：标题行（名称 + 徽标 + 状态 pill 组）+ 描述 / 说明 / 路径 / 错误行
 *  + 右侧动作列。不可展开；可展开场景用 ExpandableCard。 */
export function RowCard(props: {
  title: ReactNode
  /** 紧跟标题后的静态徽标（来源、传输形态等，弱化 pill）。 */
  badge?: ReactNode
  pills?: readonly PillData[]
  description?: ReactNode
  /** 次级说明行（适用时机等，弱化色）。 */
  note?: ReactNode
  /** 等宽字体的路径行（超出省略）。 */
  path?: ReactNode
  /** 错误行（错误色，最多两行截断）。 */
  error?: string
  actions?: ReactNode
}) {
  return (
    <section className={shared.row}>
      <div className={shared.rowMain}>
        <div className={shared.rowTitleLine}>
          <span className={shared.rowName}>{props.title}</span>
          {props.badge}
          {props.pills?.map((pill, index) => (
            <Pill key={index} text={pill.text} tone={pill.tone} title={pill.title} />
          ))}
        </div>
        {props.description !== undefined ? <p className={shared.rowDesc}>{props.description}</p> : null}
        {props.note !== undefined ? <p className={shared.rowWhen}>{props.note}</p> : null}
        {props.error !== undefined ? (
          <p className={shared.rowErrText} title={props.error}>
            {props.error}
          </p>
        ) : null}
        {props.path !== undefined ? <p className={shared.rowPath}>{props.path}</p> : null}
      </div>
      {props.actions !== undefined ? <div className={shared.rowActions}>{props.actions}</div> : null}
    </section>
  )
}
