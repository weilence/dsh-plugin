import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import { deleteSession, runBatch } from './api'
import type { BatchItem } from '../shared'
import type { Message } from './locales'

export type BatchKind = 'archive' | 'unarchive' | 'delete' | 'migrate' | 'preset'

export interface BatchOutcomeItem {
  sessionId: SessionId
  title: string
  ok: boolean
  /** 成功为语义摘要（级联数 / 迁移 / 预设），失败为服务端原始原因。 */
  summary: Message
}

export interface BatchOutcome {
  kind: BatchKind
  items: BatchOutcomeItem[]
  /** 重试所需的原始请求参数。 */
  request?: { workspaceId?: string; toPreset?: string }
}

export interface BatchState {
  active: boolean
  running: boolean
  /** 跨过滤切换保留的已选会话；退出批量模式即清空。 */
  selection: SessionId[]
  outcome: BatchOutcome | null
}

export interface SessionsState {
  /** 正在执行行操作的会话 id 与动作；全部行按钮共用互斥。 */
  working: { id: SessionId; kind: 'archive' | 'restore' | 'delete' } | null
  /** 待确认的删除目标（确认弹窗）。 */
  pendingDelete: { id: SessionId; title: string } | null
  notice: Message | null
  batch: BatchState
}

const INITIAL: SessionsState = {
  working: null,
  pendingDelete: null,
  notice: null,
  batch: { active: false, running: false, selection: [], outcome: null },
}

export interface BatchTarget {
  id: SessionId
  title: string
}

/** store 内部已定型的提示词；避免把翻译后的文本再包一层错误。 */
class StaticMessage extends Error {
  constructor(readonly value: Message) {
    super('static-message')
  }
}

function summarizeBatchItem(item: BatchItem): Message {
  if (!item.ok) return { text: item.error }
  if ('cascaded' in item) return { key: 'batch.cascaded' }
  if ('deletedSubagents' in item.result) {
    return item.result.deletedSubagents.length > 0
      ? { key: 'batch.deletedCascade', params: { count: item.result.deletedSubagents.length } }
      : { key: 'batch.deleted' }
  }
  if ('moved' in item.result) {
    return item.result.membershipPending !== undefined
      ? { text: item.result.membershipPending }
      : item.result.moved
        ? { key: 'batch.migrated' }
        : { key: 'batch.attached' }
  }
  return item.result.migrated
    ? { key: 'batch.presetDone', params: { to: item.result.newPreset } }
    : { key: 'batch.presetUnchanged', params: { preset: item.result.newPreset } }
}

export class SessionsStore {
  private snapshot: SessionsState = INITIAL
  private readonly listeners = new Set<() => void>()
  // 归档、恢复与删除都占用宿主侧存储互斥，客户端先挡掉并发点击。
  private working = false
  private batchWorking = false

  constructor(
    private readonly workspaces: IWorkspaces,
    private readonly refreshSessions: () => Promise<void>,
  ) {}

  getSnapshot = (): SessionsState => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private set(patch: Partial<SessionsState>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of this.listeners) listener()
  }

  private setBatch(patch: Partial<BatchState>): void {
    this.set({ batch: { ...this.snapshot.batch, ...patch } })
  }

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  /** 面板卸载即清空一次性反馈：notice 与批量结果不在下次打开时重放。 */
  dismissFeedback(): void {
    if (this.snapshot.notice !== null || this.snapshot.batch.outcome !== null) {
      this.set({ notice: null })
      this.setBatch({ outcome: null })
    }
  }

  /** 打开 / 关闭删除确认弹窗；操作进行中不动弹窗。 */
  askDelete(target: { id: SessionId; title: string } | null): void {
    if (this.working) return
    this.set({ pendingDelete: target })
  }

  /** 归档一个会话（官方命令；仍有活动时被宿主拒绝，错误原样展示）。 */
  async archive(id: SessionId, title: string): Promise<void> {
    await this.runRowAction(id, 'archive', async () => {
      await this.workspaces.archiveSession(id)
      return { key: 'archive.archived', params: { title } }
    })
  }

  /** 恢复一个归档会话（官方命令取消归档）。 */
  async restore(id: SessionId, title: string): Promise<void> {
    await this.runRowAction(id, 'restore', async () => {
      const current = this.workspaces.list.getSnapshot()
      if (current.phase !== 'ready' || current.state !== 'idle') {
        throw new StaticMessage(
          current.error === null
            ? { key: 'archive.unavailable' }
            : { text: `${current.error.code}: ${current.error.message}` },
        )
      }
      if (!current.archivedSessionIds.includes(id)) {
        return { key: 'archive.alreadyRestored', params: { title } }
      }
      await this.workspaces.unarchiveSession(id)
      return { key: 'archive.restored', params: { title } }
    })
  }

  /** 永久删除一个会话及其子会话日志并清理账本；成功后全量刷新官方会话列表。 */
  async remove(id: SessionId, title: string): Promise<void> {
    await this.runRowAction(id, 'delete', async () => {
      this.set({ pendingDelete: null })
      const result = await deleteSession(id)
      if (result.archiveClearError !== undefined) {
        throw new StaticMessage({
          key: 'archive.archiveClearFailed',
          params: { detail: result.archiveClearError },
        })
      }
      try {
        await this.refreshSessions()
      } catch (error) {
        throw new StaticMessage({ key: 'archive.refreshFailed', params: { detail: errMsg(error) } })
      }
      let notice: Message
      if (result.deletedSubagents.length > 0) {
        notice = { key: 'archive.deletedCascade', params: { title, count: result.deletedSubagents.length } }
      } else if (result.filesRemoved) {
        notice = { key: 'archive.deleted', params: { title } }
      } else {
        notice = { key: 'archive.deletedNoFiles', params: { title } }
      }
      return notice
    })
  }

  private async runRowAction(
    id: SessionId,
    kind: 'archive' | 'restore' | 'delete',
    action: () => Promise<Message>,
  ): Promise<void> {
    if (this.working || this.batchWorking) return
    this.working = true
    this.set({ working: { id, kind }, notice: null })
    try {
      const notice = await action()
      this.set({ notice })
    } catch (error) {
      const message = error instanceof StaticMessage ? error.value : { text: errMsg(error) }
      this.set({ notice: message })
    } finally {
      this.working = false
      this.set({ working: null })
    }
  }

  toggleBatchMode(): void {
    if (this.batchWorking) return
    this.setBatch({ active: !this.snapshot.batch.active, selection: [], outcome: null })
  }

  toggleSelected(id: SessionId): void {
    if (this.batchWorking) return
    const selection = this.snapshot.batch.selection
    this.setBatch({
      selection: selection.includes(id)
        ? selection.filter((candidate) => candidate !== id)
        : [...selection, id],
    })
  }

  selectVisible(ids: readonly SessionId[]): void {
    if (this.batchWorking) return
    this.setBatch({ selection: [...new Set([...this.snapshot.batch.selection, ...ids])] })
  }

  clearSelection(): void {
    if (this.batchWorking) return
    this.setBatch({ selection: [] })
  }

  dismissOutcome(): void {
    this.setBatch({ outcome: null })
  }

  /** 批量归档 / 恢复：客户端逐项循环官方命令，结果进结果弹窗。 */
  async runBatchArchive(targets: readonly BatchTarget[], mode: 'archive' | 'unarchive'): Promise<void> {
    await this.runBatchAction(mode, targets, undefined, async () => {
      const items: BatchOutcomeItem[] = []
      for (const { id, title } of targets) {
        try {
          if (mode === 'archive') await this.workspaces.archiveSession(id)
          else await this.workspaces.unarchiveSession(id)
          items.push({
            sessionId: id,
            title,
            ok: true,
            summary: { key: mode === 'archive' ? 'batch.archived' : 'batch.unarchived' },
          })
        } catch (error) {
          items.push({ sessionId: id, title, ok: false, summary: { text: errMsg(error) } })
        }
      }
      return items
    })
  }

  /** 批量删除：host 逐项执行（级联去重），完成即刷新官方会话列表。 */
  async runBatchDelete(targets: readonly BatchTarget[]): Promise<void> {
    await this.submitHostBatch('delete', targets, undefined)
  }

  async runBatchMigrate(targets: readonly BatchTarget[], workspaceId: string): Promise<void> {
    await this.submitHostBatch('migrate', targets, { workspaceId })
  }

  async runBatchPreset(targets: readonly BatchTarget[], toPreset: string): Promise<void> {
    await this.submitHostBatch('preset', targets, { toPreset })
  }

  /** 对结果弹窗中的失败项重跑同一动作与同一请求参数。 */
  async retryOutcome(): Promise<void> {
    const outcome = this.snapshot.batch.outcome
    if (outcome === null) return
    const targets = outcome.items
      .filter((item) => !item.ok)
      .map(({ sessionId, title }) => ({ id: sessionId, title }))
    if (targets.length === 0) return
    if (outcome.kind === 'archive' || outcome.kind === 'unarchive') {
      await this.runBatchArchive(targets, outcome.kind)
    } else {
      await this.submitHostBatch(outcome.kind, targets, outcome.request)
    }
  }

  private async submitHostBatch(
    kind: 'delete' | 'migrate' | 'preset',
    targets: readonly BatchTarget[],
    request: { workspaceId?: string; toPreset?: string } | undefined,
  ): Promise<void> {
    await this.runBatchAction(kind, targets, request, async () => {
      const titles = new Map(targets.map(({ id, title }) => [id, title]))
      const result = await runBatch({
        action: kind,
        sessionIds: targets.map(({ id }) => id),
        payload: request,
      })
      return result.items.map((item) => ({
        sessionId: item.sessionId as SessionId,
        title: titles.get(item.sessionId as SessionId) ?? item.sessionId,
        ok: item.ok,
        summary: summarizeBatchItem(item),
      }))
    })
  }

  private async runBatchAction(
    kind: BatchKind,
    targets: readonly BatchTarget[],
    request: { workspaceId?: string; toPreset?: string } | undefined,
    execute: () => Promise<BatchOutcomeItem[]>,
  ): Promise<void> {
    if (this.batchWorking || targets.length === 0) return
    this.batchWorking = true
    this.setBatch({ running: true })
    try {
      const items = await execute()
      const failed = items.filter((item) => !item.ok).length
      this.setBatch({ running: false, outcome: { kind, items, request } })
      if (kind === 'delete') {
        try {
          await this.refreshSessions()
        } catch {
          // 刷新失败不抹掉结果弹窗；侧栏过期摘要在下次刷新或重启后消除。
        }
      }
      this.set({ notice: { key: 'batch.done', params: { ok: items.length - failed, fail: failed } } })
    } catch (error) {
      // 整批未被执行（认证、参数或网络层失败）：无逐项结果，只提示。
      this.setBatch({ running: false })
      this.set({ notice: { text: errMsg(error) } })
    } finally {
      this.batchWorking = false
    }
  }
}
