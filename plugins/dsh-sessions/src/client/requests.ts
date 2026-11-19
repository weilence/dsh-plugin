import type { SessionId } from '@deepseek-ai/dsh-session'

/** 一条待处理弹窗请求：菜单条目发起，shell.overlay 常驻条目消费。 */
export interface SessionDialogRequest {
  kind: 'migrate' | 'preset'
  sessionId: SessionId
  title: string
}

export function createRequestsBridge() {
  let request: SessionDialogRequest | null = null
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => request,
    open: (next: SessionDialogRequest) => {
      request = next
      listeners.forEach((listener) => listener())
    },
    close: () => {
      request = null
      listeners.forEach((listener) => listener())
    },
  }
}

export type RequestsBridge = ReturnType<typeof createRequestsBridge>
