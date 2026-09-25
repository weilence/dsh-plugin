// quota-pill — 输入框行内用量胶囊（触发器 + portal 宿主）。
// 位置测量（useAnchoredPosition）、外点关闭、Escape 关闭的 hook 留在本组件，
// 与拆分前同一生命周期以保证行为不变；浮层内容见 quota-panel.tsx。
// 数据（res）由 client.tsx 的 ZhipuQuotaChip 轮询后下发。

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { clsx } from 'clsx'
import {
	IconGaugeOutlineRegular,
	Pill,
	useAnchoredPosition,
	useDismissOnOutsidePointer,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
	fmtPct,
	remainingPct,
	remTier,
	type UsageResult,
} from './quota-shared'
import { QuotaPanel } from './quota-panel'
import styles from './quota-pill.module.css'

// ── 展示模型：胶囊段落 ────────────────────────────────────────────────────

interface PillWindow {
	key: string
	display: string
	aria: string
	tier: string | undefined
}

function pillWindows(res: UsageResult | null): PillWindow[] {
	if (res === null || !res.ok) return []
	return res.windows.map((window) => {
		const remaining = remainingPct(window.usedPct)
		return {
			key: window.id,
			display: fmtPct(remaining),
			aria: window.label + '剩余 ' + fmtPct(remaining),
			tier: remTier(remaining),
		}
	})
}

// 最紧张的窗口剩余（全部窗口的最小值）；无数值时为 null。
function worstRemaining(res: UsageResult | null) {
	if (res === null || !res.ok) return null
	let worst: number | null = null
	for (const window of res.windows) {
		const remaining = remainingPct(window.usedPct)
		if (remaining !== null && (worst === null || remaining < worst)) worst = remaining
	}
	return worst
}

// ── 展示 ─────────────────────────────────────────────────────────────────

interface QuotaPillProps {
	res: UsageResult | null
	onForceRefresh: () => void
}

export function QuotaPill(props: QuotaPillProps) {
	const res = props.res

	const [open, setOpen] = useState(false)
	const rootRef = useRef<HTMLSpanElement>(null)
	const panelRef = useRef<HTMLDivElement>(null)
	const pos = useAnchoredPosition({
		open,
		anchorRef: rootRef,
		panelRef,
		side: 'top',
		align: 'end',
		gap: 8,
		margin: 12,
	})
	useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
	useEffect(() => {
		if (!open) return
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') setOpen(false)
		}
		document.addEventListener('keydown', onKey)
		return () => { document.removeEventListener('keydown', onKey) }
	}, [open])

	const windows = pillWindows(res)
	const worst = worstRemaining(res)

	// 图标 flex:none 恒可见；文字收进 .label（窄宽省略），完整读数进 aria-label 与浮层。
	const aria: string[] = []
	const text: ReactNode[] = []
	if (res === null) {
		text.push('智谱剩余…')
		aria.push('智谱剩余额度加载中')
	} else if (!res.ok) {
		text.push(<span key="e" className={styles.err}>智谱剩余不可用</span>)
		aria.push('智谱剩余额度不可用')
	} else {
		text.push('智谱')
		aria.push('智谱剩余额度')
		for (const window of windows) {
			text.push(<span key={window.key + '-sep'} className={styles.sep} aria-hidden>·</span>)
			text.push(
				<span key={window.key} className={clsx(styles.pct, window.tier)}>
					{window.display}
				</span>,
			)
			aria.push(window.aria)
		}
	}
	const label: ReactNode[] = [
		<IconGaugeOutlineRegular key="i" className={remTier(worst)} />,
		<span key="t" className={styles.label}>{text}</span>,
	]

	// Pill 传 onClick 渲染为 button，省略则为非交互 span（官方无数据 pill 同款退化）。
	const trigger = res === null
		? <Pill aria-label={aria.join('，')}>{label}</Pill>
		: <Pill
			type="button"
			active={open}
			aria-haspopup="dialog"
			aria-expanded={open}
			aria-label={aria.join('，')}
			onClick={() => { setOpen(!open) }}
		>{label}</Pill>

	return (
		<span ref={rootRef} className={styles.anchor}>
			{trigger}
			{open && createPortal(
				<QuotaPanel
					res={res}
					pos={pos}
					panelRef={panelRef}
					onForceRefresh={props.onForceRefresh}
				/>,
				document.body,
			)}
		</span>
	)
}
