import type { ReactNode } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import shared from './shared.module.css'

/** 通用弹窗：官方 Modal 之上的薄封装，只固化本仓差异——宽度档位
 *  （sm 720 / lg 920，窄屏自动放开高度）与 content 区滚动；按钮组
 *  对齐交给官方 footer 槽位。 */
export function Dialog(props: {
  title: string
  onClose(): void
  size?: 'sm' | 'lg'
  description?: string
  actions?: ReactNode
  children: ReactNode
}) {
  const size = props.size === 'lg' ? shared.dialogLg : shared.dialogSm
  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.title}
      closeLabel="关闭"
      description={props.description}
      className={size}
      contentClassName={shared.scrollBody}
      footer={props.actions !== undefined ? <div className={shared.actions}>{props.actions}</div> : null}
    >
      {props.children}
    </Modal>
  )
}
