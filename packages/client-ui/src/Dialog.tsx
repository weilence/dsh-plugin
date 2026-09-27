import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'

/** 通用弹窗：官方 Modal 之上的薄封装，固化本仓的三件事——宽度档位
 *  （xs 560 / sm 720 / lg 920，窄屏自动放开高度）、content 区滚动
 *  （scrollBody）、footer 结构（meta 左侧说明 + actions 右侧按钮组；
 *  无 meta 时按钮组右对齐）。 */
export function Dialog(props: {
  title: string
  onClose(): void
  /** 宽度档位，缺省 sm。 */
  size?: 'xs' | 'sm' | 'lg'
  /** 标题下的说明行（官方 description）。 */
  description?: string
  closeLabel?: string
  /** footer 左侧说明文字（写入目标、patch id 等）；缺省时按钮组右对齐。 */
  meta?: ReactNode
  /** footer 右侧动作按钮组。 */
  actions?: ReactNode
  children: ReactNode
}) {
  const size = props.size === 'xs' ? shared.dialogXs : props.size === 'lg' ? shared.dialogLg : shared.dialogSm
  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.title}
      closeLabel={props.closeLabel ?? '关闭'}
      description={props.description}
      className={size}
      contentClassName={shared.scrollBody}
      footer={
        props.meta !== undefined || props.actions !== undefined ? (
          <div className={shared.footer}>
            {props.meta !== undefined ? <span className={shared.footerMeta}>{props.meta}</span> : null}
            {props.actions !== undefined ? <div className={shared.actions}>{props.actions}</div> : null}
          </div>
        ) : null
      }
    >
      {props.children}
    </Modal>
  )
}
