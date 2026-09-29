import type { ReactNode } from 'react'
import shared from './shared.module.css'

export function Panel(props: {
  title: ReactNode
  subtitle?: ReactNode
  /** 头部右侧内容（标题列 flex:1 占位，右侧天然靠右）。 */
  headerExtra?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={shared.panel}>
      <header className={shared.panelHead}>
        <div className={shared.panelHeadMain}>
          <h2 className={shared.panelTitle}>{props.title}</h2>
          {props.subtitle !== undefined ? <p className={shared.panelSubtitle}>{props.subtitle}</p> : null}
        </div>
        {props.headerExtra}
      </header>
      {props.children}
    </section>
  )
}
