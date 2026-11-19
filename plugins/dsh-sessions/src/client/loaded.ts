/** 弹窗加载探针：probing 期间禁用提交；loaded 禁用并给行内提示；探测失败按「未知」放行，host 侧守卫兜底。 */
import { useEffect, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session'

export type LoadProbePhase = 'probing' | 'free' | 'loaded' | 'unknown'

/** 弹窗打开时探一次官方 session.state（active ⇔ 宿主持有活 agent，读取不激活会话），随弹窗重挂重新探测。 */
export function useLoadProbe(
  probeSessionLoaded: (sessionId: SessionId, signal?: AbortSignal) => Promise<boolean>,
  sessionId: SessionId,
): LoadProbePhase {
  const [phase, setPhase] = useState<LoadProbePhase>('probing')
  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    probeSessionLoaded(sessionId, controller.signal)
      .then((active) => {
        if (!cancelled) setPhase(active ? 'loaded' : 'free')
      })
      .catch(() => {
        if (!cancelled) setPhase('unknown')
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [probeSessionLoaded, sessionId])
  return phase
}
