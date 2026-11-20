import { NoticeRelay } from '@dsh-plugins/client-ui/notice-relay'
import { errMsg } from '@dsh-plugins/shared'
import { remoteApi } from './api'
import type { PanelMessage, RemoteKey } from './locales'
import { targetRequiresSecret } from '../shared'
import type {
  ConnRow,
  LocalRowsResponse,
  RegistryPluginInstall,
  SaveRequest,
  SshHostsResponse,
  StateResponse,
  SyncKind,
  TestRequest,
} from '../shared'

/** 需要口令但当前没有时的补录目标（补完继续原动作）。 */
export interface SecretPrompt {
  id: string
  action: 'connect' | 'sync' | 'upgrade'
  /** action='sync' 时的同步类别。 */
  kind: SyncKind | null
  busy: boolean
  error: PanelMessage | null
}

export interface RemoteState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** 插件文案用词典 key 表达，Host errMsg 用 text 原样；渲染期随宿主语言翻译。 */
  error: PanelMessage | null
  /** 事件 toast（自动恢复 / 自动重连 / 同步完成与失败）经 store.toasts 通道
   *  投递，由壳层 shell.overlay 的常驻显示点渲染并消费——通道无订阅者即丢弃，
   *  显示点挂载期始终在订阅，触发面关闭前后完成的反馈都必达。 */
  list: StateResponse | null
  localRows: LocalRowsResponse | null
  /** 展开中的连接 id（编辑 / 详情）。 */
  editingId: string | undefined
  creating: boolean
  /** 按钮级忙（保存 / 删除等待中）。 */
  busyId: string | null
  /** 表单里的探针请求进行中（不占连接操作位）。 */
  testing: boolean
  /** 表单测试的行内结果（成功摘要 / 失败原因）：随表单常驻显示、下一次测试
   *  开始时清空——错误与校验反馈默认行内，不走 toast。 */
  testResult: { ok: boolean; message: PanelMessage } | null
  /** ~/.ssh/config 清单（表单选择器打开时懒加载）。 */
  sshHosts: SshHostsResponse | null
  sshHostsLoading: boolean
  sshHostsError: PanelMessage | null
  /** 删除确认弹窗的目标连接。 */
  deleting: ConnRow | null
  /** 升级确认弹窗的目标连接（远端 dsh 落后本机时的「升级远端」动作）。 */
  upgrading: ConnRow | null
  /** 同步弹窗的目标：连接 + 从下拉菜单选定的类别（勾选清单在弹窗内编辑）。 */
  syncing: { id: string; kind: SyncKind } | null
  /** 未连接时点「同步插件」的引导目标（插件安装依赖连接部署出的远端 dsh）。 */
  connectPrompt: ConnRow | null
  /** 失败详情弹窗的目标连接（「连接失败」badge 点击打开）。 */
  failedDetail: ConnRow | null
  /** 密码登录缺口令时的补录弹窗（宿主重启后丢失会话口令的典型路径）。 */
  secretPrompt: SecretPrompt | null
}

const INITIAL: RemoteState = {
  status: 'idle',
  error: null,
  list: null,
  localRows: null,
  editingId: undefined,
  creating: false,
  busyId: null,
  testing: false,
  testResult: null,
  sshHosts: null,
  sshHostsLoading: false,
  sshHostsError: null,
  deleting: null,
  upgrading: null,
  syncing: null,
  connectPrompt: null,
  failedDetail: null,
  secretPrompt: null,
}

const FAST_POLL_MS = 1_200
const SLOW_POLL_MS = 6_000

const TRANSIENT_PHASES = new Set(['probing', 'deploying', 'starting'])

function anyBusy(connections: readonly ConnRow[]): boolean {
  return connections.some((row) => row.state.op !== null || TRANSIENT_PHASES.has(row.state.phase))
}

/** 口令弹窗的触发条件只有一条：密码登录 + 当前没有可用口令。别名连接与
 *  密钥文件（口令可选）永远不会命中——别名不补密码是刻意的设计。 */
function needsSecret(row: ConnRow): boolean {
  return targetRequiresSecret(row.target) && row.secretState === 'none'
}

/** 四个同步类别的完成 / 失败整句键（toast 是跨语言切换存活的描述子，模板
 *  整句入词典，不把可译片段当参数拼接）。 */
const SYNC_TOAST_KEYS: Record<string, { failed: RemoteKey; generic: RemoteKey }> = {
  'sync-skills': { failed: 'toast.syncFailed.skills', generic: 'toast.syncDoneGeneric.skills' },
  'sync-mcp': { failed: 'toast.syncFailed.mcp', generic: 'toast.syncDoneGeneric.mcp' },
  'sync-plugins': { failed: 'toast.syncFailed.plugins', generic: 'toast.syncDoneGeneric.plugins' },
  'sync-prompts': { failed: 'toast.syncFailed.prompts', generic: 'toast.syncDoneGeneric.prompts' },
}

/** 同步操作的完成摘要（op 从 sync-* 变为空时投递 toast）。引擎提交即执行、
 *  无跳过概念，摘要只报处理量。 */
function syncDoneToast(kind: string, row: ConnRow): PanelMessage {
  const keys = SYNC_TOAST_KEYS[kind]
  if (keys === undefined) return { text: kind }
  if (row.state.error !== null) {
    return { key: keys.failed, params: { detail: row.state.error.message } }
  }
  if (kind === 'sync-skills' && row.state.lastSync.skills !== null) {
    return { key: 'toast.syncDone.skills', params: { pushed: row.state.lastSync.skills.pushed } }
  }
  if (kind === 'sync-mcp' && row.state.lastSync.mcp !== null) {
    return { key: 'toast.syncDone.mcp', params: { count: row.state.lastSync.mcp.installed.length } }
  }
  if (kind === 'sync-plugins' && row.state.lastSync.plugins !== null) {
    return { key: 'toast.syncDone.plugins', params: { count: row.state.lastSync.plugins.installed.length } }
  }
  if (kind === 'sync-prompts' && row.state.lastSync.prompts !== null && row.state.lastSync.prompts.pushed) {
    return { key: 'toast.syncDone.promptsPushed' }
  }
  return { key: keys.generic }
}

export class RemoteStore {
  /** 事件 toast 通道：自动恢复 / 自动重连与同步结果在此投递，壳层常驻显示点
   *  订阅渲染（emit 无订阅者即丢弃——显示点注册早于面板可打开，投递时必然
   *  在订阅）。重复投递换 nonce 重开计时（由共享套件保证），无残留无重放。 */
  readonly toasts = new NoticeRelay<PanelMessage>()
  private snapshot: RemoteState = INITIAL
  private readonly listeners = new Set<() => void>()
  private fastTimer: ReturnType<typeof setInterval> | null = null
  private slowTimer: ReturnType<typeof setInterval> | null = null
  private refreshGeneration = 0
  private refreshRunning = false
  private refreshDirty = false
  private readonly prevPhase = new Map<string, string>()
  private readonly prevOps = new Map<string, string | null>()
  /** 面板观察窗口：startPolling（面板挂载）开、stopPolling（卸载）关。store 的
   *  刷新只由面板侧驱动，默认即观察中；窗口关闭后在途的 refresh 只更新数据，
   *  不记录迁移记忆、不发事件 toast，也不再起轮询定时器。 */
  private observing = true

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

  /** 轮询间检测操作迁移并投递事件 toast：自动恢复 / 自动重连必须区分成因
   *  （用户没有点过连接，是实例停了被拉起 / 隧道断了被重建），同步是长操作
   *  且弹窗已关、摘要靠 toast 呈现。用户发起的连接 / 升级完成不发 toast——
   *  spinner 终态、阶段 pill 与版本事实行已是常驻反馈。 */
  private detectTransitions(next: StateResponse): void {
    let toast: PanelMessage | null = null
    for (const row of next.connections) {
      const before = this.prevPhase.get(row.id)
      this.prevPhase.set(row.id, row.state.phase)
      const prevOp = this.prevOps.get(row.id) ?? null
      const opKind = row.state.op?.kind ?? null
      this.prevOps.set(row.id, opKind)
      if (
        toast === null &&
        before === 'starting' &&
        row.state.phase === 'running' &&
        row.state.running !== null &&
        (prevOp === 'recover' || prevOp === 'reconnect')
      ) {
        toast =
          prevOp === 'recover'
            ? { key: 'toast.recovered', params: { label: row.label } }
            : { key: 'toast.reconnected', params: { label: row.label } }
      }
      if (toast === null && prevOp !== null && opKind === null && prevOp.startsWith('sync-')) {
        toast = syncDoneToast(prevOp, row)
      }
    }
    if (toast !== null) this.toasts.emit(toast)
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
      // 关闭窗口后在途的 refresh：数据照常落（重开面板立即见最新状态），但迁移
      // 检测跳过——否则跨关闭窗口完成的迁移会在下次打开面板时补发迟到的 toast。
      if (this.observing) this.detectTransitions(list)
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
    // 面板已关闭（含关闭瞬间在途的 refresh 落地）：不再起任何定时器，轮询随
    // 面板关闭即停——后台空转的轮询只会产生无人即时可见的 toast。
    if (!this.observing) return
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
    this.observing = true
    void this.refresh()
    this.schedulePoll()
  }

  /** 面板卸载的唯一出口（面板卸载 cleanup 调用）：除停轮询外，丢弃迁移记忆——
   *  prev 记忆只在同一观察窗口内有效，跨关闭窗口完成的阶段 / 同步迁移是旧闻
   *  （事实由卡片状态 pill / spinner 呈现），重开面板首轮 refresh 不据此补发
   *  toast。事件 toast 通道由常驻显示点自清，这里不经手。 */
  stopPolling(): void {
    this.observing = false
    if (this.fastTimer !== null) {
      clearInterval(this.fastTimer)
      this.fastTimer = null
    }
    if (this.slowTimer !== null) {
      clearInterval(this.slowTimer)
      this.slowTimer = null
    }
    this.prevPhase.clear()
    this.prevOps.clear()
  }

  async loadLocalRows(): Promise<void> {
    try {
      this.set({ localRows: await remoteApi.localRows() })
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
    }
  }

  /** 表单打开时读一次 ~/.ssh/config（选择器与输入联想共用）。 */
  async loadSshHosts(): Promise<void> {
    if (this.snapshot.sshHostsLoading) return
    this.set({ sshHostsLoading: true, sshHostsError: null })
    try {
      this.set({ sshHosts: await remoteApi.sshHosts(), sshHostsLoading: false })
    } catch (error) {
      this.set({ sshHostsLoading: false, sshHostsError: { text: errMsg(error) } })
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

  askUpgrade(row: ConnRow | null): void {
    this.set({ upgrading: row })
  }

  askConnect(row: ConnRow | null): void {
    this.set({ connectPrompt: row })
  }

  askFailedDetail(row: ConnRow | null): void {
    this.set({ failedDetail: row })
  }

  private rowOf(id: string): ConnRow | undefined {
    return this.snapshot.list?.connections.find((row) => row.id === id)
  }

  /** 同步入口：需要口令时先补录，补完再开弹窗（弹窗打开即读远端清单，必须先
   *  能 ssh 到远端）。 */
  askSync(target: { id: string; kind: SyncKind } | null): void {
    if (target === null) {
      this.set({ syncing: null })
      return
    }
    const row = this.rowOf(target.id)
    if (row !== undefined && needsSecret(row)) {
      this.set({
        secretPrompt: { id: target.id, action: 'sync', kind: target.kind, busy: false, error: null },
      })
      return
    }
    this.set({ syncing: target })
  }

  closeSecretPrompt(): void {
    this.set({ secretPrompt: null })
  }

  /** 提交现场补录的口令（只进宿主内存），成功后继续原动作。 */
  async submitSecret(secret: string): Promise<void> {
    const prompt = this.snapshot.secretPrompt
    if (prompt === null || prompt.busy) return
    this.set({ secretPrompt: { ...prompt, busy: true, error: null } })
    try {
      await remoteApi.setSecret(prompt.id, secret)
      // 先刷新：后续动作的门控看的是刷新后的 secretState
      await this.refresh()
      this.set({ secretPrompt: null })
      if (prompt.action === 'connect') await this.connect(prompt.id)
      else if (prompt.action === 'upgrade') await this.upgrade(prompt.id)
      else if (prompt.kind !== null) this.askSync({ id: prompt.id, kind: prompt.kind })
    } catch (error) {
      this.set({ secretPrompt: { ...prompt, busy: false, error: { text: errMsg(error) } } })
    }
  }

  async save(request: SaveRequest): Promise<boolean> {
    const key = request.id ?? 'new'
    this.set({ busyId: key, error: null })
    try {
      await remoteApi.save(request)
      await this.refresh()
      this.set({ editingId: request.id === undefined ? undefined : this.snapshot.editingId })
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
      this.set({ editingId: undefined })
      return true
    } catch (error) {
      this.set({ error: { text: errMsg(error) } })
      return false
    } finally {
      this.set({ busyId: null, deleting: null })
    }
  }

  /** 表单里的测试：结果落 testResult 行内常驻在表单（成功摘要 / 失败原因），
   *  不占连接状态、不发 toast。 */
  async testDraft(request: TestRequest): Promise<void> {
    this.set({ testing: true, error: null, testResult: null })
    try {
      const result = await remoteApi.test(request)
      if (result.ok) {
        const params = { node: result.nodeVersion ?? '?', npm: result.npmVersion ?? '?' }
        this.set({
          testResult: {
            ok: true,
            message:
              result.dshVersion === null
                ? { key: 'form.testOkNoDsh', params }
                : { key: 'form.testOk', params: { ...params, dsh: result.dshVersion } },
          },
        })
      } else {
        const detail = result.error?.message ?? ''
        this.set({
          testResult: {
            ok: false,
            message:
              detail.length === 0
                ? { key: 'form.testFailedNoReason' }
                : { key: 'form.testFailed', params: { detail } },
          },
        })
      }
    } catch (error) {
      this.set({
        testResult: { ok: false, message: { key: 'form.testFailed', params: { detail: errMsg(error) } } },
      })
    } finally {
      this.set({ testing: false })
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
    const row = this.rowOf(id)
    if (row !== undefined && needsSecret(row)) {
      this.set({
        secretPrompt: { id, action: 'connect', kind: null, busy: false, error: null },
      })
      return Promise.resolve()
    }
    return this.run(id, () => remoteApi.connect(id))
  }

  /** 手动升级远端（远端 dsh 落后本机时的卡片动作）：需要口令时先补录，补完
   *  继续升级。长操作随即返回，进度由卡片 spinner 呈现。 */
  upgrade(id: string): Promise<void> {
    const row = this.rowOf(id)
    if (row !== undefined && needsSecret(row)) {
      this.set({
        secretPrompt: { id, action: 'upgrade', kind: null, busy: false, error: null },
      })
      return Promise.resolve()
    }
    return this.run(id, () => remoteApi.upgrade(id))
  }

  sync(id: string, kind: SyncKind, names: string[], registryInstall?: RegistryPluginInstall): Promise<void> {
    return this.run(id, () => remoteApi.sync(id, kind, names, registryInstall))
  }
}
