// quota-panel — 用量浮窗内容（MenuSurface；portal 到 body 由 quota-pill 托管）。
// 浮层用官方 MenuSurface primitive（模型选择弹窗同款材质：menu-surface-fill
// 半透明填充 + backdrop-filter 毛玻璃、--dsw-radius-lg 圆角、macOS 不透明
// backing），面板自身只管布局与内容（布局样式见 quota-panel.module.css）。
// ok/warn/crit tier 类来自 quota-pill.module.css（remTier 产出，调色板单点定义）。

import { clsx } from 'clsx'
import type { CSSProperties, RefObject } from 'react'
import {
	Button,
	IconGaugeOutlineRegular,
	IconRefreshOutlineRegular,
	MenuSurface,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { fmtPct, remainingPct, remTier, resetCompact, type UsageResult } from './quota-shared'
import styles from './quota-panel.module.css'

interface QuotaPanelProps {
	res: UsageResult | null
	/** useAnchoredPosition 的实测坐标；null 时加 measure 类隐藏占位。 */
	pos: CSSProperties | null
	panelRef: RefObject<HTMLDivElement>
	onForceRefresh: () => void
}

export function QuotaPanel(props: QuotaPanelProps) {
	const res = props.res
	const busy = res === null

	return (
		<MenuSurface
			ref={props.panelRef}
			className={clsx(styles.panel, props.pos == null && styles.measure)}
			role="dialog"
			aria-label="智谱剩余额度"
			style={props.pos ?? undefined}
		>
			<div className={styles.title}>
				<span className={styles.titleLabel}>
					<IconGaugeOutlineRegular />
					智谱剩余额度
				</span>
			</div>
			<div className={styles.titleRule} aria-hidden />
			{res !== null && res.ok ? (
				<div className={styles.windows}>
					{res.windows.map((window) => {
						const remaining = remainingPct(window.usedPct)
						return (
							<div key={window.id} className={styles.window}>
								<div className={styles.windowName}>{window.label}</div>
								<div className={styles.windowValue}>
									<span className={remTier(remaining)}>{fmtPct(remaining)}</span>
									{' · ' + resetCompact(window.resetMs)}
								</div>
								<div className={styles.bar}>
									<div
										className={clsx(styles.fill, remTier(remaining))}
										style={{ width: (remaining ?? 0) + '%' }}
									/>
								</div>
							</div>
						)
					})}
				</div>
			) : (
				<dl className={styles.details}>
					<dt>{res === null ? '状态' : '错误'}</dt>
					<dd>{res === null ? '加载中…' : res.error || '查询失败'}</dd>
				</dl>
			)}
			<div className={styles.footerRule} aria-hidden />
			<div className={styles.footer}>
				<Button
					variant="ghost"
					size="sm"
					icon={<IconRefreshOutlineRegular size={14} />}
					className={styles.refreshButton}
					disabled={busy}
					onClick={props.onForceRefresh}
				>
					{busy ? '刷新中…' : '强制刷新'}
				</Button>
				<span className={styles.note}>open.bigmodel.cn · 4 分钟缓存 · 15 秒轮询</span>
			</div>
		</MenuSurface>
	)
}
