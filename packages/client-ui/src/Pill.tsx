import type { ReactNode } from 'react'
import shared from './shared.module.css'

export type PillTone = 'neutral' | 'ok' | 'err' | 'warn' | 'brand'

export interface PillData {
  text: ReactNode
  tone?: PillTone
  /** 悬停说明（完整路径、上游详情等）。 */
  title?: string
  /** 提供即渲染为按钮（阻断行头展开的冒泡），用于徽标本身是入口的行。 */
  onClick?: () => void
}

/** 状态小徽标：`.pill` 基类（字号 / 圆角 / 内边距）恒定应用，tone 类只覆盖
 *  配色——base 与 tone 必须同时挂，否则语气色 pill 会丢基类字号。 */
export function Pill(props: { text: ReactNode; tone?: PillTone; title?: string; onClick?: () => void }) {
  const toneCls =
    props.tone === 'ok'
      ? shared.pillOk
      : props.tone === 'err'
        ? shared.pillErr
        : props.tone === 'warn'
          ? shared.pillWarn
          : props.tone === 'brand'
            ? shared.pillBrand
            : undefined
  const className = toneCls === undefined ? shared.pill : `${shared.pill} ${toneCls}`
  if (props.onClick === undefined) {
    return (
      <span className={className} title={props.title}>
        {props.text}
      </span>
    )
  }
  return (
    <button
      type="button"
      className={`${className} ${shared.pillButton}`}
      title={props.title}
      onClick={(event) => {
        // 徽标入口的点击只属于徽标，不触发行展开 / 收起。
        event.stopPropagation()
        props.onClick?.()
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {props.text}
    </button>
  )
}
