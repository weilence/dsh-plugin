import { errMsg } from '@dsh-plugins/shared'
import { endpointApi } from './api'
import type { EndpointStatusView } from '../shared'
import type { ZhipuT } from './locales'

/** apply 成功后的补偿刷新时刻（毫秒）：覆盖 patch watcher 重整 → 重挂载的窗口期。 */
const COMPENSATING_REFRESH_MS = [1_200, 4_000] as const

export interface EndpointState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  /** apply 失败原文（渲染在按钮旁；成功或下次重试时清空）。 */
  applyError: string | null
  view: EndpointStatusView | null
}

const INITIAL: EndpointState = {
  status: 'idle',
  error: null,
  notice: null,
  applyError: null,
  view: null,
}

export class EndpointStore {
  private snapshot: EndpointState = INITIAL
  private readonly listeners = new Set<() => void>()
  private refreshGeneration = 0

  // notice 是写入成功的即显 Toast：事件时间取词，不跨语言切换存活。
  constructor(private readonly t: ZhipuT) {}

  getSnapshot = (): EndpointState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<EndpointState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    if (this.snapshot.status === 'idle') this.set({ status: 'loading' })
    return endpointApi
      .status()
      .then((view) => {
        if (generation !== this.refreshGeneration) return
        this.set({ status: 'ready', error: null, view })
      })
      .catch((error: unknown) => {
        if (generation !== this.refreshGeneration) return
        this.set({ status: 'error', error: errMsg(error) })
      })
  }

  /** 一键写入内置 Web 搜索配置：成功即显 Toast 并补偿刷新两次；失败原文留在按钮旁。 */
  async apply(): Promise<void> {
    const view = this.snapshot.view
    if (view === null) return
    this.set({ applyError: null })
    try {
      await endpointApi.applyWebConfig({ expectedMtimeMs: view.patchMtimeMs ?? undefined })
      this.set({ notice: this.t('notice.applied'), applyError: null })
      for (const delay of COMPENSATING_REFRESH_MS) {
        setTimeout(() => void this.refresh(), delay)
      }
    } catch (error) {
      this.set({ applyError: errMsg(error) })
    }
  }
}
