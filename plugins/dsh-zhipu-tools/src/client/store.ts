import { errMsg } from '@dsh-plugins/shared'
import { switchApi } from './api'
import type { SearchSwitchView } from '../shared'

export interface SearchSwitchState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  view: SearchSwitchView | null
  busy: boolean
  /** 刚写入、宿主尚未应用的目标值；结算后清空。 */
  pending: boolean | null
}

const INITIAL: SearchSwitchState = {
  status: 'idle',
  error: null,
  notice: null,
  view: null,
  busy: false,
  pending: null,
}

/** 写入后等待 HMR 生效的补偿刷新延迟。 */
const SETTLE_DELAYS_MS = [1200, 4000] as const

export class SearchSwitchStore {
  private snapshot: SearchSwitchState = INITIAL
  private readonly listeners = new Set<() => void>()
  private refreshGeneration = 0

  getSnapshot = (): SearchSwitchState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<SearchSwitchState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    if (this.snapshot.status === 'idle') this.set({ status: 'loading' })
    return switchApi
      .state()
      .then((view) => {
        if (generation !== this.refreshGeneration) return
        const settled = this.snapshot.pending !== null && view.active === this.snapshot.pending
        this.set({
          status: 'ready',
          error: null,
          view,
          ...(settled ? { pending: null } : {}),
        })
      })
      .catch((error: unknown) => {
        if (generation !== this.refreshGeneration) return
        this.set({ status: 'error', error: errMsg(error) })
      })
  }

  /** 开 / 关。写入成功后补偿刷新覆盖宿主应用窗口；失败返回 false。 */
  async setEnabled(enabled: boolean): Promise<boolean> {
    this.set({ busy: true, error: null, notice: null })
    try {
      const outcome = await switchApi.set({ enabled })
      const hint = outcome.written
        ? `已写入 ${outcome.scope} 层 patch，${enabled ? '开启' : '关闭'}替换`
        : `已处于${enabled ? '开启' : '关闭'}状态，未改动文件`
      this.set({ pending: enabled, notice: hint })
      await this.refresh()
      SETTLE_DELAYS_MS.forEach((delay, index) => {
        const isLast = index === SETTLE_DELAYS_MS.length - 1
        setTimeout(() => {
          void this.refresh().then(() => {
            // 末次刷新仍未追上（无 HMR 需重启 / 被更高层覆盖）：按实际状态展示。
            if (isLast && this.snapshot.pending === enabled && !this.snapshot.busy) {
              this.set({ pending: null })
            }
          })
        }, delay)
      })
      return true
    } catch (error) {
      this.set({ error: errMsg(error), pending: null })
      return false
    } finally {
      this.set({ busy: false })
    }
  }
}
