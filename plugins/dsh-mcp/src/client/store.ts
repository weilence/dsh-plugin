import { errMsg } from '@dsh-plugins/shared'
import { mcpApi } from './api'
import type { DeleteRequest, ListResponse, SaveRequest, SetEnabledRequest } from '../shared'

export interface McpState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  list: ListResponse | null
  /** 正在写入的行 id（保存 / 启停 / 删除中）。 */
  busy: string | null
}

const INITIAL: McpState = {
  status: 'idle',
  error: null,
  notice: null,
  list: null,
  busy: null,
}

/** 写入后等待 HMR 生效的补偿刷新延迟。 */
const SETTLE_DELAYS_MS = [1200, 4000] as const

export class McpStore {
  private snapshot: McpState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** 串行化刷新，避免并发刷新互相覆盖。 */
  private refreshTail: Promise<void> = Promise.resolve()
  private refreshLoading = false
  private refreshDirty = false
  private refreshGeneration = 0

  getSnapshot = (): McpState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<McpState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  fail(message: string): void {
    this.set({ error: message, notice: null })
  }

  // 页面打开时多个事件常常接连到来，加载进行中的触发只标记 dirty，完成后
  // 至多补拉一次。
  refresh(): Promise<void> {
    if (this.refreshLoading) {
      this.refreshDirty = true
      return this.refreshTail
    }
    this.refreshLoading = true
    const run = async (): Promise<void> => {
      try {
        do {
          this.refreshDirty = false
          await this.load()
        } while (this.refreshDirty)
      } catch {
        // load 自行捕获错误；这里额外捕获，避免链条被 reject 污染。
      } finally {
        this.refreshLoading = false
      }
    }
    this.refreshTail = this.refreshTail.then(run, run)
    return this.refreshTail
  }

  private async load(): Promise<void> {
    const generation = ++this.refreshGeneration
    if (this.snapshot.status === 'idle') this.set({ status: 'loading' })
    try {
      const response = await mcpApi.list()
      // 卸载或过期响应：丢弃。
      if (generation !== this.refreshGeneration) return
      this.set({ status: 'ready', error: null, list: response })
    } catch (error) {
      if (generation !== this.refreshGeneration) return
      this.set({ status: 'error', error: errMsg(error) })
    }
  }

  /** 写操作成功后的刷新：立即一次，再按延迟补偿 HMR 生效窗口。 */
  private async refreshAfterMutation(notice: string): Promise<void> {
    this.set({ notice })
    await this.refresh()
    for (const delay of SETTLE_DELAYS_MS) {
      const generation = this.refreshGeneration
      window.setTimeout(() => {
        if (generation <= this.refreshGeneration) void this.refresh()
      }, delay)
    }
  }

  /** 保存（新建 / 编辑）。失败返回 false 且错误已写入快照。 */
  async save(request: SaveRequest): Promise<boolean> {
    const key = request.id ?? `new:${request.config.serverName}`
    this.set({ busy: key, error: null, notice: null })
    try {
      const outcome = await mcpApi.save(request)
      await this.refreshAfterMutation(
        request.id === undefined
          ? `已创建服务器 ${request.config.serverName}（写入 ${outcome.scope} 层，等待 HMR 应用）`
          : `已保存服务器 ${request.config.serverName}（等待 HMR 应用）`,
      )
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 启用 / 停用。失败返回 false 且错误已写入快照。 */
  async setEnabled(request: SetEnabledRequest): Promise<boolean> {
    this.set({ busy: request.id, error: null, notice: null })
    try {
      const outcome = await mcpApi.setEnabled(request)
      await this.refreshAfterMutation(`已${outcome.enabled ? '启用' : '停用'} ${request.id}（等待 HMR 应用）`)
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 删除一条声明。失败返回 false 且错误已写入快照。 */
  async remove(request: DeleteRequest, label: string): Promise<boolean> {
    this.set({ busy: request.id, error: null, notice: null })
    try {
      await mcpApi.delete(request)
      await this.refreshAfterMutation(`已删除服务器 ${label}（等待 HMR 卸载）`)
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }
}
