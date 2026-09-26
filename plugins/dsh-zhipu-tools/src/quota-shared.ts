import { useCallback, useEffect, useState } from 'react'
import { toneStyles } from '@dsh-plugins/client-ui/tone'
import { errMsg } from '@dsh-plugins/shared'
import type { QuotaWindow, UsageResult } from './usage'

// 本模块不 import 任何组件，避免 pill/panel 之间的循环依赖。
export type { QuotaWindow, UsageResult }

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

// 接口 percentage 是已用%；面板统一展示剩余（对齐官方「剩余额度」语义）。
export function remainingPct(usedPct: number | null) {
  if (usedPct === null) return null
  return Math.min(100, Math.max(0, 100 - usedPct))
}

// 剩余越少越警告：≤10% 红、≤30% 黄、其余正常。
export function remTier(remaining: number | null) {
  if (remaining === null) return undefined
  if (remaining <= 10) return toneStyles.err
  if (remaining <= 30) return toneStyles.warn
  return toneStyles.ok
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
