import { errMsg } from '@dsh-plugins/shared'
import { configApi } from './api'
import type { StatusView } from '../shared'

export interface ConfigState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** 开关写入失败原文（渲染在开关旁；成功或下次重试时清空）。 */
  toggleError: string | null
  /** 开关写入进行中（进行中开关拒绝输入）。 */
  pending: boolean
  view: StatusView | null
}

const INITIAL: ConfigState = {
  status: 'idle',
  error: null,
  toggleError: null,
  pending: false,
  view: null,
}

export class ConfigStore {
  private snapshot: ConfigState = INITIAL
  private readonly listeners = new Set<() => void>()
  private refreshGeneration = 0

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

  /**
   * 切换智谱搜索开关：成功以响应的最新状态视图为准（开关状态只认服务端事实，
   * 开关本身就是结果，不弹提示）；失败原文留在开关旁，开关保持原状态。
   */
  async toggle(enabled: boolean): Promise<void> {
    if (this.snapshot.view === null || this.snapshot.pending) return
    this.set({ pending: true, toggleError: null })
    try {
      const view = await configApi.setWebConfig({ enabled })
      this.set({ toggleError: null, view })
    } catch (error) {
      this.set({ toggleError: errMsg(error) })
    } finally {
      this.set({ pending: false })
    }
  }
}
