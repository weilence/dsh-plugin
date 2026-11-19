import type { ReactNode } from 'react'
import styles from './panel-page.module.css'

/** 全局面板页壳：`main` keyed 页面的版式底座——滚动视口 + 官方同款居中
 *  内容列，页头承载一级标题（`actions` 是页头行尾的操作组，可省）。 */
export function PanelPage(props: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={styles.page}>
      <div className={styles.scroll}>
        <div className={styles.content}>
          <header className={styles.head}>
            <h1 className={styles.title}>{props.title}</h1>
            {props.actions}
          </header>
          {props.subtitle !== undefined ? <p className={styles.subtitle}>{props.subtitle}</p> : null}
          {props.children}
        </div>
      </div>
    </div>
  )
}
