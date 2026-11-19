import type { SiteDraft, SitesView, TestResponse } from '../shared'
import { gitlabApi } from './api'
// 纯通道子路径：不拖入依赖宿主原语的视图模块（store half 的测试不换 env）
import { NoticeRelay } from '@dsh-plugins/client-ui/notice-relay'

export interface PanelState {
  view: SitesView | null
  loading: boolean
  /** 任一写操作进行中：全部动作按钮禁用。 */
  busy: boolean
  /** 正在测试连接的站点名。 */
  testing: string | null
  /** 站点名 → 最近一次测试结果。 */
  testResults: Record<string, TestResponse>
  /** 面板级读取失败（列表拉取）；写操作失败归各行与表单。 */
  loadError: string | null
  /** 保存表单的错误原文（渲染在保存按钮旁）。 */
  formError: string | null
  /** 行内动作（删除 / 测试）失败的原文。 */
  rowErrors: Record<string, string>
  /** 主视图会话工作目录（sessions.list 快照）；list 请求随附兜底工作区关联。 */
  workspaceCwd: string | undefined
}

const INITIAL: PanelState = {
  view: null,
  loading: false,
  busy: false,
  testing: null,
  testResults: {},
  loadError: null,
  formError: null,
  rowErrors: {},
  workspaceCwd: undefined,
}

type ApiOutcome = { ok: true } | { ok: false; reason: string }

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * 面板 store：只持事实，一次性操作反馈（保存 / 删除，事件时间取词）经 notices
 * 通道送面板显示——无订阅者（分区未挂载）即丢弃，重开详情页不重放旧 Toast。
 */
export class GitlabStore {
  private state: PanelState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** 一次性操作反馈通道：壳层常驻显示点（GitlabNoticesToast）订阅显示，onDone 清空。 */
  readonly notices = new NoticeRelay<string>()

  readonly getSnapshot = (): PanelState => this.state

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private patch(partial: Partial<PanelState>): void {
    this.state = { ...this.state, ...partial }
    for (const listener of this.listeners) listener()
  }

  clearFormError(): void {
    if (this.state.formError !== null) this.patch({ formError: null })
  }

  setWorkspaceCwd(cwd: string | undefined): void {
    if (cwd === this.state.workspaceCwd) return
    this.patch({ workspaceCwd: cwd })
  }

  async refresh(): Promise<void> {
    this.patch({ loading: true, loadError: null })
    try {
      const view = await gitlabApi.sites(this.state.workspaceCwd)
      this.patch({ view, loading: false })
    } catch (error) {
      this.patch({ loading: false, loadError: reasonOf(error) })
    }
  }

  async save(payload: { site: SiteDraft; previousName?: string }): Promise<ApiOutcome> {
    this.patch({ busy: true, formError: null })
    try {
      const view = await gitlabApi.save(payload)
      this.patch({ busy: false, view })
      return { ok: true }
    } catch (error) {
      this.patch({ busy: false, formError: reasonOf(error) })
      return { ok: false, reason: reasonOf(error) }
    }
  }

  async remove(name: string): Promise<ApiOutcome> {
    this.patch({
      busy: true,
      rowErrors: { ...this.state.rowErrors, [name]: undefined } as Record<string, string>,
    })
    try {
      const view = await gitlabApi.remove(name)
      this.patch({ busy: false, view })
      return { ok: true }
    } catch (error) {
      this.patch({ busy: false, rowErrors: { ...this.state.rowErrors, [name]: reasonOf(error) } })
      return { ok: false, reason: reasonOf(error) }
    }
  }

  async test(site: SiteDraft): Promise<ApiOutcome> {
    const key = site.name
    this.patch({
      testing: key,
      rowErrors: { ...this.state.rowErrors, [key]: undefined } as Record<string, string>,
    })
    try {
      const result = await gitlabApi.test({ site })
      this.patch({ testing: null, testResults: { ...this.state.testResults, [key]: result } })
      return { ok: true }
    } catch (error) {
      const reason = reasonOf(error)
      this.patch({ testing: null, rowErrors: { ...this.state.rowErrors, [key]: reason } })
      return { ok: false, reason }
    }
  }
}
