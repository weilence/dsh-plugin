import type { ReactNode } from 'react'
import shared from './shared.module.css'

export function Panel(props: {
  /** 无任何头部内容时整个 header 不渲染（插件详情页的头部已是插件名与描述）。 */
  title?: ReactNode
  subtitle?: ReactNode
  /** 头部右侧内容（标题列 flex:1 占位，右侧天然靠右）。 */
  headerExtra?: ReactNode
  children: ReactNode
}) {
  const hasHeader =
    props.title !== undefined || props.subtitle !== undefined || props.headerExtra !== undefined
  return (
    <section className={shared.panel}>
      {hasHeader ? (
        <header className={shared.panelHead}>
          <div className={shared.panelHeadMain}>
            {props.title !== undefined ? <h2 className={shared.panelTitle}>{props.title}</h2> : null}
            {props.subtitle !== undefined ? <p className={shared.panelSubtitle}>{props.subtitle}</p> : null}
          </div>
          {props.headerExtra}
        </header>
      ) : null}
      {props.children}
    </section>
  )
}
