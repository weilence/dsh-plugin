import { errMsg } from '@dsh-plugins/shared'
import { endpointApi } from './api'
import type { EndpointStatusView } from '../shared'
import type { ZhipuT } from './locales'

export interface EndpointState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  view: EndpointStatusView | null
}

const INITIAL: EndpointState = {
  status: 'idle',
  error: null,
  notice: null,
  view: null,
}

export class EndpointStore {
  private snapshot: EndpointState = INITIAL
  private readonly listeners = new Set<() => void>()
  private refreshGeneration = 0

  // notice 是复制成功的即显 Toast：事件时间取词，不跨语言切换存活。
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

  /** 复制端点地址或 API 密钥：成功即显 Toast，失败清掉旧提示并把原样错误留在面板错误行。 */
  async copyUrl(): Promise<void> {
    await this.copyToClipboard(this.snapshot.view?.baseUrl, 'notice.copied')
  }

  async copyToken(): Promise<void> {
    await this.copyToClipboard(this.snapshot.view?.token, 'notice.copiedKey')
  }

  private async copyToClipboard(
    value: string | null | undefined,
    noticeKey: 'notice.copied' | 'notice.copiedKey',
  ): Promise<void> {
    if (value === undefined || value === null) return
    try {
      await navigator.clipboard.writeText(value)
      this.set({ notice: this.t(noticeKey) })
    } catch (error) {
      this.set({ error: errMsg(error), notice: null })
    }
  }
}
