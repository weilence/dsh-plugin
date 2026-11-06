/** 右键菜单「查看 Git 仓库」的待应用选择：菜单动作写入，ReposBody 应用一次后
 *  消费；模块级单例 + 订阅，标签体未挂载时先落在这里，openTab 挂载后读取。 */

export interface ContextOpen {
  /** 递增序号：ReposBody 以「已应用的序号」判定消费，避免旧值反复覆盖用户手选。 */
  version: number
  sessionId: string
  repoRoot: string
}

let current: ContextOpen | null = null
let version = 0
const listeners = new Set<() => void>()

export const getContextOpen = (): ContextOpen | null => current

export const subscribeContextOpen = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function pushContextOpen(sessionId: string, repoRoot: string): void {
  version += 1
  current = { version, sessionId, repoRoot }
  for (const listener of listeners) listener()
}
