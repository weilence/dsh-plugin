import { errMsg } from '@dsh-plugins/shared'
import { mcpApi } from './api'
import type { PanelMessage } from './locales'
import type { DeleteRequest, ListResponse, McpScope, SaveRequest, SetEnabledRequest } from '../shared'

export interface McpState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 插件文案用词典 key 表达，Host 原因用 text 原样；渲染期随宿主语言翻译。 */
  error: PanelMessage | null
  notice: PanelMessage | null
  list: ListResponse | null
  /** 主视图会话的工作目录（工作区档定位；undefined = 无主会话）。 */
  workspaceCwd: string | undefined
  /** 正在写入的行（保存 / 启停 / 删除中）。 */
  busy: string | null
}

const INITIAL: McpState = {
  status: 'idle',
  error: null,
  notice: null,
  list: null,
  workspaceCwd: undefined,
  busy: null,
}

/** 写入后等待挂载与连接落定的补偿刷新延迟。 */
const SETTLE_DELAYS_MS = [1200, 4000] as const

/** 快照里有过渡态行时的轮询间隔：连接握手与 npx 下载都以秒计，2s 粒度足够。 */
const TRANSIENT_POLL_MS = 2000

/**
 * 过渡态 = 面板展示「连接中…」（fiber pending/loading/unloading）。这些状
 * 态会自行变化，值得轮询；loader 缺席时 live 为 null 只能靠刷新，不轮询。
 */
function hasTransientRow(state: McpState): boolean {
  const list = state.list
  if (list === null) return false
  return list.servers.some((row) => {
    if (row.disabled) return false
    if (row.live === null) return false
    return row.live.status === 'pending' || row.live.status === 'loading' || row.live.status === 'unloading'
  })
}

/** 表单提交的动作事实；revision / cwd 由 store 按快照补齐。 */
export interface SaveInput {
  scope: McpScope
  name: string
  config: SaveRequest['config']
  extra?: Record<string, unknown>
  disabled?: boolean
}

export class McpStore {
  private snapshot: McpState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** 串行化刷新，避免并发刷新互相覆盖。 */
  private refreshTail: Promise<void> = Promise.resolve()
  private refreshLoading = false
  private refreshDirty = false
  private refreshGeneration = 0
  private pollTimer: ReturnType<typeof setTimeout> | null = null

  getSnapshot = (): McpState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    // 面板重新挂载时快照可能仍带过渡态行（上次挂载期间留下的），恢复轮询。
    this.scheduleTransientPoll()
    return () => {
      this.listeners.delete(listener)
      // 面板关闭后快照无人消费，继续轮询只是空转。
      if (this.listeners.size === 0) this.stopTransientPoll()
    }
  }

  private set(patch: Partial<McpState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  /** 主视图工作目录变化（client.tsx 订阅会话列表推来）；变化才重拉。 */
  setWorkspaceCwd(cwd: string | undefined): void {
    if (cwd === this.snapshot.workspaceCwd) return
    this.set({ workspaceCwd: cwd })
    void this.refresh()
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
      const response = await mcpApi.list(this.snapshot.workspaceCwd)
      // 卸载或过期响应：丢弃。
      if (generation !== this.refreshGeneration) return
      this.set({ status: 'ready', error: null, list: response })
      this.scheduleTransientPoll()
    } catch (error) {
      if (generation !== this.refreshGeneration) return
      this.set({ status: 'error', error: { text: errMsg(error) } })
    }
  }

  /** 过渡态行存在时安排下一轮刷新；已在计时 / 无人订阅 / 全部落定则不动。 */
  private scheduleTransientPoll(): void {
    if (this.pollTimer !== null || this.listeners.size === 0) return
    if (!hasTransientRow(this.snapshot)) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.refresh()
    }, TRANSIENT_POLL_MS)
  }

  private stopTransientPoll(): void {
    if (this.pollTimer === null) return
    clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  /** 写操作成功后的刷新：立即一次，再按延迟补偿挂载与连接落定的窗口。 */
  private async refreshAfterMutation(notice: PanelMessage): Promise<void> {
    this.set({ notice })
    await this.refresh()
    for (const delay of SETTLE_DELAYS_MS) {
      const generation = this.refreshGeneration
      setTimeout(() => {
        if (generation <= this.refreshGeneration) void this.refresh()
      }, delay)
    }
  }

  /** 目标文件的内容版本（乐观并发）；列表未就绪时为 null（新建空文件场景）。 */
  private revisionOf(scope: McpScope): string | null {
    return this.snapshot.list?.revisions[scope] ?? null
  }

  /** 保存（新建 / 同名覆盖编辑）。失败返回 false 且错误已写入快照。 */
  async save(input: SaveInput): Promise<boolean> {
    this.set({ busy: input.name, error: null, notice: null })
    try {
      const request: SaveRequest = {
        scope: input.scope,
        cwd: this.snapshot.workspaceCwd,
        name: input.name,
        config: input.config,
        extra: input.extra,
        disabled: input.disabled,
        revision: this.revisionOf(input.scope),
      }
      await mcpApi.save(request)
      await this.refreshAfterMutation(
        input.scope === 'global'
          ? { key: 'notice.savedGlobal', params: { name: input.name } }
          : { key: 'notice.savedWorkspace', params: { name: input.name } },
      )
      return true
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 启用 / 停用。失败返回 false 且错误已写入快照。 */
  async setEnabled(request: Omit<SetEnabledRequest, 'revision' | 'cwd'>): Promise<boolean> {
    this.set({ busy: request.name, error: null, notice: null })
    try {
      await mcpApi.setEnabled({
        ...request,
        cwd: this.snapshot.workspaceCwd,
        revision: this.revisionOf(request.scope),
      })
      await this.refreshAfterMutation({
        key: request.enabled ? 'notice.enabled' : 'notice.disabled',
        params: { name: request.name },
      })
      return true
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 删除一条声明。失败返回 false 且错误已写入快照。 */
  async remove(request: Omit<DeleteRequest, 'revision' | 'cwd'>, label: string): Promise<boolean> {
    this.set({ busy: request.name, error: null, notice: null })
    try {
      await mcpApi.delete({
        ...request,
        cwd: this.snapshot.workspaceCwd,
        revision: this.revisionOf(request.scope),
      })
      await this.refreshAfterMutation({ key: 'notice.deleted', params: { name: label } })
      return true
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
      return false
    } finally {
      this.set({ busy: null })
    }
  }
}
