import type { ReactNode } from 'react'
import shared from './shared.module.css'

/** 设置页面板骨架：标题 + 副标题 + 头部右侧附加内容的单列面板，
 *  列表 / 工具条 / 弹窗等正文由 children 组成。 */
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
