/** 一次性通知的消息体；nonce 随每次投递递增，作 Toast 的 key 使同文案重新计时。 */
export interface Notice<M> {
  message: M
  nonce: number
}

/**
 * 一次性通知通道：emit 在无订阅者时直接丢弃。仓库约定消费方是常驻显示点
 * （`ResidentNoticeToast`，挂宿主壳层 `shell.overlay` 槽位）——挂载期始终有订阅者，
 * 触发面关闭前后完成的反馈都必达；显示点 onDone 清空，无残留无重放。
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
