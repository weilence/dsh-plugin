/** 悬停弹出延时（毫秒）的共享 store：插件详情页配置面板写、提交图面板读，两者
 *  可能同时挂载（设置浮层盖在主界面上），模块级单例 + 订阅保证两处一致；值持久化
 *  在 localStorage，存储不可用（测试环境、隐私模式）时降级为仅当前会话生效。 */

export const DEFAULT_HOVER_DELAY_MS = 500
export const MIN_HOVER_DELAY_MS = 0
export const MAX_HOVER_DELAY_MS = 5000

const STORAGE_KEY = 'dsh-git.hoverDelayMs'

const clamp = (value: number): number => Math.min(MAX_HOVER_DELAY_MS, Math.max(MIN_HOVER_DELAY_MS, value))

function readStored(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_HOVER_DELAY_MS
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) ? clamp(parsed) : DEFAULT_HOVER_DELAY_MS
  } catch {
    return DEFAULT_HOVER_DELAY_MS
  }
}

let current = readStored()
const listeners = new Set<() => void>()

export const getHoverDelay = (): number => current

export const subscribeHoverDelay = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function setHoverDelay(raw: number): void {
  if (!Number.isFinite(raw)) return
  const next = clamp(raw)
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, String(next))
  } catch {
    // 存储不可用：仅当前会话内生效
  }
  for (const listener of listeners) listener()
}
