import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'

/** 通用弹窗：官方 Modal 之上的薄封装，固化本仓的两件事——宽度档位
 *  （xs 560 / sm 720 / lg 920，窄屏自动放开高度）与 content 区滚动
 *  （scrollBody）；footer 只承接右侧动作按钮组，对齐交给官方 Modal 的
 *  footer 槽位。 */
export function Dialog(props: {
  title: string
  onClose(): void
  /** 宽度档位，缺省 sm。 */
  size?: 'xs' | 'sm' | 'lg'
  /** 标题下的说明行（官方 description）。 */
  description?: string
  closeLabel?: string
  /** footer 动作按钮组。 */
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
      footer={props.actions !== undefined ? <div className={shared.actions}>{props.actions}</div> : null}
    >
      {props.children}
    </Modal>
  )
}
