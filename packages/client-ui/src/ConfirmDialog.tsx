import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './shared.module.css'

export interface ConfirmDialogProps {
  title: string
  body: string
  confirmLabel: string
  busy: boolean
  onCancel(): void
  onConfirm(): void
}

// 外壳为官方 Modal：遮罩点击 / Escape / aria 由官方维护，多层弹窗叠放时
// 官方层栈保证一次 Escape 只关最上层。
export function ConfirmDialog(props: ConfirmDialogProps) {
  return (
    <Modal
      open
      onClose={() => {
        if (!props.busy) props.onCancel()
      }}
      title={props.title}
      closeLabel="关闭"
      description={props.body}
      footer={
        <>
          <Button variant="outline" disabled={props.busy} onClick={props.onCancel}>
            取消
          </Button>
          <Button
            variant="primary"
            className={styles.dangerButton}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </Button>
        </>
      }
    />
  )
}
