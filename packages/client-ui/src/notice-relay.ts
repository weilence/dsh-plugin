/** 一次性通知的消息体；nonce 随每次投递递增，作 Toast 的 key 使同文案重新计时。 */
export interface Notice<M> {
  message: M
  nonce: number
}

/**
 * 一次性通知通道：emit 在无订阅者时直接丢弃——分区卸载后完成的迟到反馈无处显示，
 * 排队只会在下次打开分区时重放。订阅/退订对齐分区挂载/卸载（useNotice 的 effect 生命周期）。
 * 零依赖模块（单独子路径导出）：store half 可直接引用，不拖入官方原语。
 */
export class NoticeRelay<M> {
  private readonly listeners = new Set<(message: M) => void>()

  emit(message: M): void {
    if (this.listeners.size === 0) return
    for (const listener of this.listeners) listener(message)
  }

  subscribe(listener: (message: M) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
