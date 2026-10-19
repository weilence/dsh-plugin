import { errMsg } from '@dsh-plugins/shared'
import { configApi } from './api'
import type { StatusView } from '../shared'
import type { ZhipuT } from './locales'

export interface ConfigState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  /** apply 失败原文（渲染在按钮旁；成功或下次重试时清空）。 */
  applyError: string | null
  view: StatusView | null
}

const INITIAL: ConfigState = {
  status: 'idle',
  error: null,
  notice: null,
  applyError: null,
  view: null,
}

export class ConfigStore {
  private snapshot: ConfigState = INITIAL
  private readonly listeners = new Set<() => void>()
  private refreshGeneration = 0

  // notice 是写入成功的即显 Toast：事件时间取词，不跨语言切换存活。
  constructor(private readonly t: ZhipuT) {}

  getSnapshot = (): ConfigState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<ConfigState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  refresh(): Promise<void> {
    const generation = ++this.refreshGeneration
    if (this.snapshot.status === 'idle') this.set({ status: 'loading' })
    return configApi
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

  /** 一键把 web 行的 provider 选择改写到本插件：成功即显 Toast；失败原文留在按钮旁。 */
  async apply(): Promise<void> {
    if (this.snapshot.view === null) return
    this.set({ applyError: null })
    try {
      await configApi.applyWebConfig()
      this.set({ notice: this.t('notice.applied'), applyError: null })
    } catch (error) {
      this.set({ applyError: errMsg(error) })
    }
  }
}
