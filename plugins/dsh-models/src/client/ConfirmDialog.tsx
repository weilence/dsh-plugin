// 通用小确认对话框（删除 route / 移除模型 / 放弃未保存修改等）。
//
// 外壳用官方 primitives 的 Modal（body portal、遮罩点击 / Escape 关闭、
// aria 由官方维护）；busy 期间所有关闭路径都在 onClose 里统一守卫。
// 多层弹窗叠放时一次 Escape 只关最上层，由官方 Modal 的层栈保证。

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

export function ConfirmDialog(props: ConfirmDialogProps) {
	const close = () => {
		if (!props.busy) props.onCancel()
	}
	return (
		<Modal
			open
			onClose={close}
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
