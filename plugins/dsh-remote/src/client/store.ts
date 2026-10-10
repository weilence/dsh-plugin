import { errMsg } from '@dsh-plugins/shared'
import { remoteApi } from './api'
import type { PanelMessage, RemoteKey } from './locales'
import type {
  ConnRow,
  LocalRowsResponse,
  RegistryPluginInstall,
  SaveRequest,
  StateResponse,
  SyncKind,
  TestResponse,
} from '../shared'

export interface RemoteState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 插件文案用词典 key 表达，Host errMsg 用 text 原样；渲染期随宿主语言翻译。 */
  error: PanelMessage | null
  notice: PanelMessage | null
  list: StateResponse | null
  localRows: LocalRowsResponse | null
  /** 展开中的连接 id（编辑 / 详情）。 */
  editingId: string | undefined
  creating: boolean
  /** 按钮级忙（保存 / 删除 / 测试等待中）。 */
  busyId: string | null
  /** 最近一次探针结果（面板内联展示）。 */
  testResult: { id: string; result: TestResponse } | null
  /** 删除确认弹窗的目标连接。 */
  deleting: ConnRow | null
  /** 同步弹窗的目标：连接 + 从下拉菜单选定的类别（勾选清单在弹窗内编辑）。 */
  syncing: { id: string; kind: SyncKind } | null
  /** 未连接时点「同步插件」的引导目标（插件安装依赖连接部署出的远端 dsh）。 */
  connectPrompt: ConnRow | null
  /** 失败详情弹窗的目标连接（「连接失败」badge 点击打开）。 */
  failedDetail: ConnRow | null
}

const INITIAL: RemoteState = {
  status: 'idle',
  error: null,
  notice: null,
  list: null,
  localRows: null,
  editingId: undefined,
  creating: false,
  busyId: null,
  testResult: null,
  deleting: null,
  syncing: null,
  connectPrompt: null,
  failedDetail: null,
}

const FAST_POLL_MS = 1_200
const SLOW_POLL_MS = 6_000

const TRANSIENT_PHASES = new Set(['probing', 'deploying', 'starting'])

function anyBusy(connections: readonly ConnRow[]): boolean {
  return connections.some((row) => row.state.op !== null || TRANSIENT_PHASES.has(row.state.phase))
}

/** 四个同步类别的完成 / 失败整句键（notice 是跨语言切换存活的 toast，模板
 *  整句入词典，不把可译片段当参数拼接）。 */
const SYNC_NOTICE_KEYS: Record<string, { failed: RemoteKey; generic: RemoteKey }> = {
  'sync-skills': { failed: 'notice.syncFailed.skills', generic: 'notice.syncDoneGeneric.skills' },
  'sync-mcp': { failed: 'notice.syncFailed.mcp', generic: 'notice.syncDoneGeneric.mcp' },
  'sync-plugins': { failed: 'notice.syncFailed.plugins', generic: 'notice.syncDoneGeneric.plugins' },
  'sync-prompts': { failed: 'notice.syncFailed.prompts', generic: 'notice.syncDoneGeneric.prompts' },
}

/** 同步操作的完成摘要（op 从 sync-* 变为空时发 notice）。 */
function syncDoneNotice(kind: string, row: ConnRow): PanelMessage {
  const keys = SYNC_NOTICE_KEYS[kind]
  if (keys === undefined) return { text: kind }
  if (row.state.error !== null) {
    return { key: keys.failed, params: { detail: row.state.error.message } }
  }
  if (kind === 'sync-skills' && row.state.lastSync.skills !== null) {
    const { pushed, skipped } = row.state.lastSync.skills
    return skipped > 0
      ? { key: 'notice.syncDone.skillsSkipped', params: { pushed, count: skipped } }
      : { key: 'notice.syncDone.skills', params: { pushed } }
  }
  if (kind === 'sync-mcp' && row.state.lastSync.mcp !== null) {
    const { installed, skipped } = row.state.lastSync.mcp
    return skipped.length > 0
      ? { key: 'notice.syncDone.mcpSkipped', params: { count: installed.length, skipped: skipped.length } }
      : { key: 'notice.syncDone.mcp', params: { count: installed.length } }
  }
  if (kind === 'sync-plugins' && row.state.lastSync.plugins !== null) {
    const { installed, skipped } = row.state.lastSync.plugins
    return skipped.length > 0
      ? {
          key: 'notice.syncDone.pluginsSkipped',
          params: { count: installed.length, skipped: skipped.length },
        }
      : { key: 'notice.syncDone.plugins', params: { count: installed.length } }
  }
  if (kind === 'sync-prompts' && row.state.lastSync.prompts !== null) {
    const { pushed, skipped } = row.state.lastSync.prompts
    return pushed
      ? { key: 'notice.syncDone.promptsPushed' }
      : skipped
        ? { key: 'notice.syncDone.promptsSkipped' }
        : { key: 'notice.syncDone.promptsUnchanged' }
  }
  return { key: keys.generic }
}

export class RemoteStore {
  private snapshot: RemoteState = INITIAL
  private readonly listeners = new Set<() => void>()
  private fastTimer: ReturnType<typeof setInterval> | null = null
  private slowTimer: ReturnType<typeof setInterval> | null = null
  private refreshGeneration = 0
  private refreshRunning = false
  private refreshDirty = false
  private readonly prevPhase = new Map<string, string>()
  private readonly prevOps = new Map<string, string | null>()

  getSnapshot = (): RemoteState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<RemoteState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** 轮询间检测阶段 / 操作迁移：连接成功与同步完成发 notice——连接成功
   *  不自动开页（入口常驻在卡片「打开」按钮），同步是长操作且弹窗已关，
   *  结果靠 toast 呈现。 */
  private detectTransitions(next: StateResponse): void {
    let notice: PanelMessage | null = null
    for (const row of next.connections) {
      const before = this.prevPhase.get(row.id)
      this.prevPhase.set(row.id, row.state.phase)
      if (
        notice === null &&
        before === 'starting' &&
        row.state.phase === 'running' &&
        row.state.running !== null
      ) {
        notice = { key: 'notice.connected', params: { label: row.label } }
      }
      const prevOp = this.prevOps.get(row.id) ?? null
      const opKind = row.state.op?.kind ?? null
      this.prevOps.set(row.id, opKind)
      if (notice === null && prevOp !== null && opKind === null && prevOp.startsWith('sync-')) {
        notice = syncDoneNotice(prevOp, row)
      }
    }
    if (notice !== null) this.set({ notice })
  }

  async refresh(): Promise<void> {
    if (this.refreshRunning) {
      this.refreshDirty = true
      return
    }
    this.refreshRunning = true
    const generation = ++this.refreshGeneration
    try {
      const list = await remoteApi.state()
      if (generation !== this.refreshGeneration) return
      this.detectTransitions(list)
      this.set({ status: 'ready', list, error: null })
    } catch (error) {
      if (generation !== this.refreshGeneration) return
      this.set({ status: this.snapshot.list === null ? 'error' : 'ready', error: { text: errMsg(error) } })
    } finally {
      this.refreshRunning = false
      if (this.refreshDirty) {
        this.refreshDirty = false
        void this.refresh()
      }
    }
    this.schedulePoll()
  }

  private schedulePoll(): void {
    const busy = this.snapshot.list !== null && anyBusy(this.snapshot.list.connections)
    if (busy && this.fastTimer === null) {
      this.fastTimer = setInterval(() => void this.refresh(), FAST_POLL_MS)
    } else if (!busy && this.fastTimer !== null) {
      clearInterval(this.fastTimer)
      this.fastTimer = null
    }
    if (this.slowTimer === null) {
      this.slowTimer = setInterval(() => void this.refresh(), SLOW_POLL_MS)
    }
  }

  startPolling(): void {
    void this.refresh()
    this.schedulePoll()
  }

  stopPolling(): void {
    if (this.fastTimer !== null) {
      clearInterval(this.fastTimer)
      this.fastTimer = null
    }
    if (this.slowTimer !== null) {
      clearInterval(this.slowTimer)
      this.slowTimer = null
    }
  }

  async loadLocalRows(): Promise<void> {
    try {
      this.set({ localRows: await remoteApi.localRows() })
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
    }
  }

  edit(id: string | undefined): void {
    this.set({ editingId: id, creating: false })
  }

  create(): void {
    this.set({ creating: true, editingId: undefined })
  }

  askDelete(row: ConnRow | null): void {
    this.set({ deleting: row })
  }

  askSync(target: { id: string; kind: SyncKind } | null): void {
    this.set({ syncing: target })
  }

  askConnect(row: ConnRow | null): void {
    this.set({ connectPrompt: row })
  }

  askFailedDetail(row: ConnRow | null): void {
    this.set({ failedDetail: row })
  }

  dismissNotice(): void {
    this.set({ notice: null })
  }

  async save(request: SaveRequest): Promise<boolean> {
    const key = request.id ?? 'new'
    this.set({ busyId: key, error: null, notice: null })
    try {
      await remoteApi.save(request)
      await this.refresh()
      this.set({
        notice: request.id === undefined ? { key: 'notice.created' } : { key: 'notice.saved' },
        editingId: request.id === undefined ? undefined : this.snapshot.editingId,
      })
      return true
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
      return false
    } finally {
      this.set({ busyId: null })
    }
  }

  async remove(id: string): Promise<boolean> {
    this.set({ busyId: id, error: null })
    try {
      await remoteApi.remove(id)
      await this.refresh()
      this.set({ notice: { key: 'notice.deleted' }, editingId: undefined })
      return true
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
      return false
    } finally {
      this.set({ busyId: null, deleting: null })
    }
  }

  async test(id: string): Promise<void> {
    this.set({ busyId: id, error: null })
    try {
      const result = await remoteApi.test(id)
      this.set({ testResult: { id, result } })
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
    } finally {
      this.set({ busyId: null })
    }
  }

  private async run(id: string, call: () => Promise<unknown>): Promise<void> {
    this.set({ busyId: id, error: null })
    try {
      await call()
      await this.refresh()
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
    } finally {
      this.set({ busyId: null })
    }
  }

  connect(id: string): Promise<void> {
    return this.run(id, () => remoteApi.connect(id))
  }

  sync(id: string, kind: SyncKind, names: string[], registryInstall?: RegistryPluginInstall): Promise<void> {
    return this.run(id, () => remoteApi.sync(id, kind, names, registryInstall))
  }
}
