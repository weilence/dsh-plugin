/**
 * 面板状态存储：settings 页打开期间的生命周期内持有目录快照与作用域，
 * 写操作（保存 / 删除）成功后自动刷新。不做跨组件持久订阅——面板是唯一
 * 读者，React 经 useSyncExternalStore 消费。
 */

import { skillsApi, errMsg } from './api'
import type { GitInstallResponse, GitScanResponse, RootId, RootInfo, SaveRequest, SkillRow } from '../shared'

export interface SkillsState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  notice: string | null
  /** 当前项目作用域（''= 用户级）。 */
  scope: string
  roots: RootInfo[]
  skills: SkillRow[]
  /** 正在写入的技能名（保存 / 删除中）。 */
  busy: string | null
  /** 正在加载原文的技能名（编辑 / 查看弹窗）。 */
  loadingFile: string | null
  /** Git 安装弹窗占用中（克隆扫描 / 复制安装）。 */
  gitBusy: 'scan' | 'install' | null
}

const INITIAL: SkillsState = {
  status: 'idle',
  error: null,
  notice: null,
  scope: '',
  roots: [],
  skills: [],
  busy: null,
  loadingFile: null,
  gitBusy: null,
}

export class SkillsStore {
  private snapshot: SkillsState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** 串行化刷新，避免并发刷新互相覆盖。 */
  private refreshTail: Promise<void> = Promise.resolve()
  private refreshLoading = false
  private refreshDirty = false

  getSnapshot = (): SkillsState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<SkillsState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  fail(message: string): void {
    this.set({ error: message, notice: null })
  }

  /** 切换项目作用域并立即刷新。 */
  setScope(scope: string): void {
    if (scope === this.snapshot.scope) return
    this.set({ scope, status: 'loading', error: null, notice: null, skills: [], roots: [] })
    void this.refresh()
  }

  // 页面打开时多个事件常常接连到来，加载进行中的触发只置脏标记，完成后
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
        // load 自行捕获错误；这里兜底，避免链条被 reject 污染。
      } finally {
        this.refreshLoading = false
      }
    }
    this.refreshTail = this.refreshTail.then(run, run)
    return this.refreshTail
  }

  private async load(): Promise<void> {
    const scope = this.snapshot.scope
    if (this.snapshot.status === 'idle') this.set({ status: 'loading' })
    try {
      const response = await skillsApi.list(scope === '' ? undefined : scope)
      // 作用域在请求期间又变了：丢弃过期响应。
      if (scope !== this.snapshot.scope) return
      this.set({
        status: 'ready',
        error: null,
        roots: response.roots,
        skills: response.skills,
      })
    } catch (error) {
      if (scope !== this.snapshot.scope) return
      this.set({ status: 'error', error: errMsg(error) })
    }
  }

  /** 拉取技能文件原文（编辑 / 查看弹窗共用）。 */
  async loadFile(name: string, path: string): Promise<string | null> {
    this.set({ loadingFile: name })
    try {
      const response = await skillsApi.file(
        path,
        this.snapshot.scope === '' ? undefined : this.snapshot.scope,
      )
      return response.raw
    } catch (error) {
      this.set({ error: errMsg(error) })
      return null
    } finally {
      this.set({ loadingFile: null })
    }
  }

  /** 保存（新建 / 编辑）。失败返回 false 且错误已写入快照。 */
  async save(request: SaveRequest): Promise<boolean> {
    this.set({ busy: request.name, error: null, notice: null })
    try {
      const outcome = await skillsApi.save(request)
      this.set({
        notice:
          request.editPath === undefined
            ? `已创建技能 ${request.name}（${outcome.path}）`
            : `已保存技能 ${request.name}`,
      })
      await this.refresh()
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 删除一个技能文件 / 目录包。失败返回 false 且错误已写入快照。 */
  async remove(skill: SkillRow): Promise<boolean> {
    if (skill.path === undefined) return false
    this.set({ busy: skill.name, error: null, notice: null })
    try {
      await skillsApi.delete({
        cwd: this.snapshot.scope === '' ? undefined : this.snapshot.scope,
        path: skill.path,
      })
      this.set({ notice: `已删除技能 ${skill.name}` })
      await this.refresh()
      return true
    } catch (error) {
      this.set({ error: errMsg(error) })
      return false
    } finally {
      this.set({ busy: null })
    }
  }

  /** 克隆并扫描 Git 仓库。失败返回 null 且错误已写入快照。 */
  async gitScan(url: string): Promise<GitScanResponse | null> {
    this.set({ gitBusy: 'scan', error: null, notice: null })
    try {
      return await skillsApi.gitScan({
        url,
        cwd: this.snapshot.scope === '' ? undefined : this.snapshot.scope,
      })
    } catch (error) {
      this.set({ error: errMsg(error) })
      return null
    } finally {
      this.set({ gitBusy: null })
    }
  }

  /** 把选中的技能整目录安装进目标根。失败返回 null 且错误已写入快照。 */
  async gitInstall(url: string, rootId: RootId, dirs: readonly string[]): Promise<GitInstallResponse | null> {
    this.set({ gitBusy: 'install', error: null, notice: null })
    try {
      const outcome = await skillsApi.gitInstall({
        url,
        cwd: this.snapshot.scope === '' ? undefined : this.snapshot.scope,
        rootId,
        skills: [...dirs],
      })
      if (outcome.installed.length > 0) {
        this.set({ notice: `已从 Git 安装 ${outcome.installed.length} 个技能：${outcome.installed.map((row) => row.name).join('、')}` })
        await this.refresh()
      }
      return outcome
    } catch (error) {
      this.set({ error: errMsg(error) })
      return null
    } finally {
      this.set({ gitBusy: null })
    }
  }
}
