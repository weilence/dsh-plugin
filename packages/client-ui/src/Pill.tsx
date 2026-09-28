import type { ReactNode } from 'react'
import shared from './shared.module.css'

export type PillTone = 'neutral' | 'ok' | 'err' | 'warn' | 'brand'

export interface PillData {
  text: ReactNode
  tone?: PillTone
  /** 悬停说明（完整路径、上游详情等）。 */
  title?: string
}

/** 状态小徽标：`.pill` 基类（字号 / 圆角 / 内边距）恒定应用，tone 类只覆盖
 *  配色——base 与 tone 必须同时挂，否则语气色 pill 会丢基类字号。 */
export function Pill(props: { text: ReactNode; tone?: PillTone; title?: string }) {
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
  return (
    <span className={toneCls === undefined ? shared.pill : `${shared.pill} ${toneCls}`} title={props.title}>
      {props.text}
    </span>
  )
}
