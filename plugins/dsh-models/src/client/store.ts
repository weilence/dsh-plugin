import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { loadCatalog } from '../catalog/parse'
import type { ModelsDevCatalog } from '../catalog/types'
import { readChoices, type PiAiChoices } from '../pi-ai/choices'
import type { DiscoveredModelFacts } from '../pi-ai/profile'
import { jsonEqual, type WriteOutcome } from '../pi-ai/ops'
import type { PiAiProviderEntry } from '../pi-ai/types'
import { buildRoutes, type PanelRoute } from '../pi-ai/view'
import { deriveKeyRef, type EffectiveModelFacts, type PiAiOperations } from './operations'
import { errMsg } from '@dsh-plugins/shared'

export interface PanelState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  writable: boolean
  /** 当前 namespace revision（写入 fencing）。 */
  revision: number | undefined
  routes: readonly PanelRoute[]
  choices: PiAiChoices
  modelsDev: ModelsDevCatalog | null
  modelsDevLoading: boolean
  modelsDevError: string | null
  busy: string | null
}

const INITIAL: PanelState = {
  status: 'idle',
  error: null,
  notice: null,
  writable: false,
  revision: undefined,
  routes: [],
  choices: readChoices(undefined),
  modelsDev: null,
  modelsDevLoading: false,
  modelsDevError: null,
  busy: null,
}

/** configForms 快照的最小消费面（官方 ConfigForm 的读侧）。 */
export type ConfigFormLike = Pick<ConfigForm<unknown>, 'getSnapshot' | 'subscribe'>

/** 事件订阅面（remote 与 cordis 的并集，够用即可）。 */
export interface StoreContext {
  remote: { $on?(name: string, listener: () => void): () => void }
  on(name: string, listener: () => void): void
  off(name: string, listener: () => void): void
}

function providersOf(root: unknown): Record<string, PiAiProviderEntry> {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return {}
  const providers = (root as Record<string, unknown>)['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) return {}
  const result: Record<string, PiAiProviderEntry> = {}
  for (const [key, value] of Object.entries(providers)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) result[key] = value
  }
  return result
}

const CONFLICT_MESSAGE = '配置已被其他窗口或外部文件修改；请刷新后重试。'

export class PanelStore {
  private readonly ctx: StoreContext
  private readonly operations: PiAiOperations
  private readonly scope: ConfigFormLike
  private readonly getChoices: () => PiAiChoices
  private snapshot: PanelState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** 最近一次刷新用的读结果缓存，供写入后局部更新。 */
  private catalogs = new Map<string, ReadonlyMap<string, DiscoveredModelFacts>>()
  private effective = new Map<string, ReadonlyMap<string, EffectiveModelFacts>>()
  /** 串行化刷新，避免并发刷新互相覆盖。 */
  private refreshTail: Promise<void> = Promise.resolve()
  /** 正在进行的全量加载；并发 refresh 触发合并为「当前这次 + 至多一次补拉」。 */
  private refreshLoading = false
  private refreshDirty = false
  /** 凭据 describe 结果缓存（按引用键）；凭据事件或本面板写入时失效。 */
  private readonly credentialCache = new Map<string, boolean>()

  constructor(options: {
    ctx: StoreContext
    operations: PiAiOperations
    scope: ConfigFormLike
    getChoices: () => PiAiChoices
  }) {
    this.ctx = options.ctx
    this.operations = options.operations
    this.scope = options.scope
    this.getChoices = options.getChoices
  }

  getSnapshot = (): PanelState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<PanelState>) {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  start(): () => void {
    const disposers: Array<() => void> = [this.scope.subscribe(() => void this.refresh())]
    if (this.ctx.remote.$on) {
      disposers.push(this.ctx.remote.$on('settings/document-updated', () => void this.refresh()))
      disposers.push(this.ctx.remote.$on('llm/adapters-updated', () => void this.refresh()))
      disposers.push(
        this.ctx.remote.$on('credentials/reference-updated', () => {
          this.credentialCache.clear()
          void this.refresh()
        }),
      )
    }
    const onReset = () => void this.refresh()
    this.ctx.on('connection/reset', onReset)
    disposers.push(() => this.ctx.off('connection/reset', onReset))
    void this.refresh()
    return () => {
      for (const dispose of disposers) dispose()
      this.listeners.clear()
    }
  }

  // 页面打开时多个事件常常接连到来，加载进行中的触发只置脏标记，完成后
  // 至多补拉一次。
  refresh(): Promise<void> {
    if (this.refreshLoading) {
      this.refreshDirty = true
      return this.refreshTail
    }
    this.refreshLoading = true
    const run = async () => {
      try {
        do {
          this.refreshDirty = false
          await this.load()
        } while (this.refreshDirty)
      } catch {
        // load 自行捕获错误；这里兜底，避免链条被 reject 污染。
      } finally {
        this.refreshLoading = false
      }
    }
    this.refreshTail = this.refreshTail.then(run, run)
    return this.refreshTail
  }

  private async load() {
    if (this.snapshot.status === 'idle') this.set({ status: 'loading' })
    try {
      const directory = await this.operations.loadDirectory()
      const settings = this.scope.getSnapshot()
      // 只为「已配置」的 route 读安装目录：官方会把全部内置 provider 声明进
      // 可配置目录（几十个），休眠 provider 的模型清单面板从不展示，逐个
      // discover 只会产生几十次无谓请求。
      const configuredProviders = new Set(Object.keys(providersOf(settings.value)))
      const catalogs = new Map<string, ReadonlyMap<string, DiscoveredModelFacts>>()
      const effective = new Map<string, ReadonlyMap<string, EffectiveModelFacts>>()
      await Promise.all(
        directory.map(async (row) => {
          if (!row.declared && configuredProviders.has(row.provider)) {
            const discovered = await this.operations.discover(row.provider)
            catalogs.set(row.provider, new Map((discovered ?? []).map((model) => [model.id, model])))
          }
          // active 蕴含 configured：已注册的 route 必然配置过。
          if (row.active) {
            const outcome = await this.operations.effective(row.provider)
            if (outcome.kind === 'found') {
              effective.set(row.provider, new Map(outcome.models.map((model) => [model.id, model])))
            }
          }
        }),
      )
      this.catalogs = catalogs
      this.effective = effective
      const routes = buildRoutes(
        { value: settings.value, user: settings.user, base: settings.base },
        directory,
        catalogs,
        effective,
      )
      this.set({
        status: 'ready',
        error: null,
        writable: settings.writable,
        revision: settings.revision,
        routes,
        choices: this.getChoices(),
      })
    } catch (error) {
      this.set({ status: 'error', error: errMsg(error) })
    }
  }

  async ensureModelsDev(force = false): Promise<ModelsDevCatalog | null> {
    if (this.snapshot.modelsDev !== null && !force) return this.snapshot.modelsDev
    this.set({ modelsDevLoading: true, modelsDevError: null })
    try {
      const catalog = await loadCatalog(force)
      this.set({ modelsDev: catalog, modelsDevLoading: false })
      return catalog
    } catch (error) {
      this.set({ modelsDevLoading: false, modelsDevError: errMsg(error) })
      return null
    }
  }

  private userProfile(provider: string): PiAiProviderEntry | undefined {
    return providersOf(this.scope.getSnapshot().user)[provider]
  }

  // 失败返回 false 且错误已写入快照（冲突给统一提示）。
  private async commitWithConflictRetry(
    op: (revision: number | undefined) => Promise<WriteOutcome>,
  ): Promise<boolean> {
    let revision = this.scope.getSnapshot().revision
    let outcome = await op(revision)
    if (outcome.kind === 'conflict') {
      await this.refresh()
      revision = this.scope.getSnapshot().revision
      outcome = await op(revision)
    }
    if (outcome.kind === 'written') return true
    this.set({ error: outcome.kind === 'conflict' ? CONFLICT_MESSAGE : outcome.message })
    return false
  }

  // 只写存储一个凭据并更新本地缓存（UI 小圆点立即可见）；failurePrefix 用于
  // 「主体已保存，但密钥失败」类提示。
  private async storeKey(ref: string, value: string, failurePrefix?: string): Promise<boolean> {
    const failure = await this.operations.storeCredential(ref, value)
    if (failure === undefined) {
      this.credentialCache.set(ref, true)
      return true
    }
    this.set({ error: failurePrefix === undefined ? failure : `${failurePrefix}${failure}` })
    return false
  }

  // 保存编辑页的整份候选 profile（连接字段 + 模型清单一次性整值写入），可选
  // 同时把 API Key 只写存入 credentials；候选必须由调用方从用户层现有 profile
  // 起步构造，这里只负责无变化短路、写入、冲突重试与凭据存储。
  async saveRoute(
    provider: string,
    candidate: PiAiProviderEntry,
    options: { apiKey?: string } = {},
  ): Promise<boolean> {
    const apiKey = options.apiKey?.trim()
    const current = this.userProfile(provider)
    const keys: Record<string, unknown> = { ...candidate }
    if (apiKey !== undefined && apiKey.length > 0) {
      keys.apiKeyEnv =
        typeof keys.apiKeyEnv === 'string' && keys.apiKeyEnv.length > 0
          ? keys.apiKeyEnv
          : deriveKeyRef(provider)
    }
    const profileChanged = !jsonEqual(keys, current ?? {})
    if (!profileChanged && (apiKey === undefined || apiKey.length === 0)) {
      this.set({ notice: '没有需要保存的修改', error: null })
      return true
    }
    this.set({ busy: provider, error: null, notice: null })
    try {
      if (profileChanged) {
        const written = await this.commitWithConflictRetry((revision) =>
          this.operations.writeProfile(provider, keys, revision),
        )
        if (!written) return false
      }
      if (apiKey !== undefined && apiKey.length > 0) {
        const ref = typeof keys.apiKeyEnv === 'string' ? keys.apiKeyEnv : deriveKeyRef(provider)
        const stored = await this.storeKey(
          ref,
          apiKey,
          profileChanged ? '配置已保存，但 API Key 保存失败：' : 'API Key 保存失败：',
        )
        if (!stored) return false
      }
      this.set({ notice: `已保存 ${provider} 的配置` })
      await this.refresh()
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  async createProvider(
    provider: string,
    profile: PiAiProviderEntry,
    options: { apiKey?: string } = {},
  ): Promise<boolean> {
    this.set({ busy: provider, error: null, notice: null })
    try {
      const keys: Record<string, unknown> = { ...profile }
      if (options.apiKey !== undefined) {
        keys.apiKeyEnv = deriveKeyRef(provider)
      }
      const written = await this.commitWithConflictRetry((revision) =>
        this.operations.writeProfile(provider, keys, revision),
      )
      if (!written) return false
      if (options.apiKey !== undefined) {
        const stored = await this.storeKey(
          String(keys.apiKeyEnv),
          options.apiKey.trim(),
          'Provider 已创建，但 API Key 保存失败：',
        )
        if (!stored) {
          // Provider 本体已写入：刷新让列表立即反映新 route。
          await this.refresh()
          return false
        }
      }
      this.set({ notice: `已保存 Provider ${provider}` })
      await this.refresh()
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 删除一个 route 的用户层 profile（不清理凭据）。 */
  async deleteProvider(provider: string): Promise<void> {
    this.set({ busy: provider, error: null, notice: null })
    try {
      const written = await this.commitWithConflictRetry((revision) =>
        this.operations.deleteProfile(provider, revision),
      )
      if (written) {
        this.set({ notice: `已删除 ${provider} 的用户层配置` })
        await this.refresh()
      }
    } catch (error) {
      this.set({ error: errMsg(error) })
    } finally {
      this.set({ busy: null })
    }
  }

  async credentialState(
    provider: string,
    ref: string | undefined,
  ): Promise<{ configured: boolean; ref: string } | undefined> {
    const target = ref ?? deriveKeyRef(provider)
    const cached = this.credentialCache.get(target)
    if (cached !== undefined) return { configured: cached, ref: target }
    try {
      const info = await this.operations.describeCredential(target)
      if (info === undefined) return undefined
      this.credentialCache.set(target, info.configured)
      return { configured: info.configured, ref: target }
    } catch {
      return undefined
    }
  }

  /** 编辑据此判断「新增会不会触发物化」，与写入看到的是同一份输入。 */
  catalogOf(provider: string): ReadonlyMap<string, DiscoveredModelFacts> {
    return this.catalogs.get(provider) ?? new Map()
  }

  dismissNotice() {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  fail(message: string) {
    this.set({ error: message, notice: null })
  }
}
