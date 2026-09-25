// quota 共享层：用量数据契约、/usage 轮询 hook、剩余换算与格式化纯函数。
// 供 client.tsx（接线）、quota-pill.tsx / quota-panel.tsx（展示）共用；
// 本模块不 import 任何组件，避免 pill/panel 之间的循环依赖。
// remTier 的 tier 调色板（ok/warn/crit）定义在 quota-pill.module.css。

import { useCallback, useEffect, useState } from 'react'
import pillStyles from './quota-pill.module.css'

// ── 用量数据：/dsh-zhipu-tools/usage 轮询 ────────────────────────────────

export interface QuotaWindow {
	id: string
	label: string
	/** API percentage（已用百分比）；展示时换算为剩余。 */
	usedPct: number | null
	resetMs: number | null
}

export type UsageResult =
	{ ok: true; windows: QuotaWindow[]; queriedAt: number } | { ok: false; error: string }

export function errMsg(error: unknown) {
	const message = (error as { message?: string } | null | undefined)?.message
	return message || String(error)
}

export function fetchQuota(force: boolean): Promise<UsageResult> {
	return fetch('/dsh-zhipu-tools/usage' + (force ? '?force=1' : '')).then((r) => r.json())
}

// active=false 时清空并停止轮询；失败结果也占位展示，30 秒后由宿主缓存过期自然恢复。
export function useUsageQuota(active: boolean) {
	const [res, setRes] = useState<UsageResult | null>(null)

	useEffect(() => {
		if (!active) {
			setRes(null)
			return
		}
		let alive = true
		const load = (force: boolean) => {
			fetchQuota(force)
				.then((next) => {
					if (alive) setRes(next)
				})
				.catch((e: unknown) => {
					if (alive) setRes({ ok: false, error: errMsg(e) })
				})
		}
		load(false)
		const timer = setInterval(() => {
			load(false)
		}, 15000)
		return () => {
			alive = false
			clearInterval(timer)
		}
	}, [active])

	const refresh = useCallback(() => {
		setRes(null)
		fetchQuota(true)
			.then((next) => setRes(next))
			.catch((e: unknown) => setRes({ ok: false, error: errMsg(e) }))
	}, [])

	return { res, refresh }
}

// ── 剩余换算与格式化（纯函数）─────────────────────────────────────────────

// 接口 percentage 是已用%；面板统一展示剩余（对齐官方「剩余额度」语义）。
export function remainingPct(usedPct: number | null) {
	if (usedPct === null) return null
	return Math.min(100, Math.max(0, 100 - usedPct))
}

// 剩余越少越警告：≤10% 红、≤30% 黄、其余正常。
// 返回的是 quota-pill.module.css 里哈希后的 tier 类；浮窗同样复用。
export function remTier(remaining: number | null) {
	if (remaining === null) return undefined
	if (remaining <= 10) return pillStyles.crit
	if (remaining <= 30) return pillStyles.warn
	return pillStyles.ok
}

export function fmtPct(v: number | null | undefined) {
	const n = Number(v)
	return n === n ? Math.round(n * 10) / 10 + '%' : '—'
}

// 紧凑重置描述：24 小时内为倒计时（H:MM / N分钟），否则日期（M月D日）。
export function resetCompact(resetMs: number | null) {
	if (resetMs === null) return '—'
	const diff = resetMs - Date.now()
	if (diff <= 0) return '—'
	if (diff < 24 * 3600000) {
		const totalMin = Math.ceil(diff / 60000)
		const h = Math.floor(totalMin / 60)
		const m = totalMin % 60
		return h > 0 ? h + ':' + String(m).padStart(2, '0') : m + '分钟'
	}
	const d = new Date(resetMs)
	return d.getMonth() + 1 + '月' + d.getDate() + '日'
}
