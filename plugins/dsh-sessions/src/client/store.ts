import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import { deleteArchivedSession } from './api'
import type { Message } from './locales'

/** 行锚定的操作失败：行还在列表时显示在行内，行随官方快照消失后回落到分区级。 */
export interface SessionFailure {
  sessionId: SessionId
  message: Message
}

export interface SessionsState {
  /** 正在恢复的归档 id。 */
  restoring: SessionId | null
  /** 正在删除的归档 id。 */
  deleting: SessionId | null
  /** 待确认的删除目标（确认弹窗）。 */
  pendingDelete: { id: SessionId; title: string } | null
  failure: SessionFailure | null
  notice: Message | null
}

const INITIAL: SessionsState = {
  restoring: null,
  deleting: null,
  pendingDelete: null,
  failure: null,
  notice: null,
}

export class SessionsStore {
  private snapshot: SessionsState = INITIAL
  private readonly listeners = new Set<() => void>()
  // 恢复与删除共用互斥：宿主侧两者都要占用存储操作锁，客户端先挡掉并发点击。
  private working = false

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

  dismissNotice(): void {
    if (this.snapshot.notice !== null) this.set({ notice: null })
  }

  /** 面板卸载即清空一次性反馈：Toast 与失败提示都不在下次打开时重放。 */
  dismissFeedback(): void {
    if (this.snapshot.notice !== null || this.snapshot.failure !== null) {
      this.set({ notice: null, failure: null })
    }
  }

  /** 打开 / 关闭删除确认弹窗；操作进行中不动弹窗。 */
  askDelete(target: { id: SessionId; title: string } | null): void {
    if (this.working) return
    this.set({ pendingDelete: target })
  }

  /** 恢复一个归档会话（经官方 unarchive 取消归档）。 */
  async restore(id: SessionId, title: string): Promise<void> {
    if (this.working) return
    this.set({ failure: null, notice: null })
    const current = this.workspaces.list.getSnapshot()
    if (current.phase !== 'ready' || current.state !== 'idle') {
      this.set({
        failure: {
          sessionId: id,
          message:
            current.error === null
              ? { key: 'archive.unavailable' }
              : { text: `${current.error.code}: ${current.error.message}` },
        },
      })
      return
    }
    if (!current.archivedSessionIds.includes(id)) {
      this.set({ notice: { key: 'archive.alreadyRestored', params: { title } } })
      return
    }
    // 官方归档命令共用请求序号；串行恢复避免不同条目的响应互相覆盖。
    this.working = true
    this.set({ restoring: id })
    try {
      await this.workspaces.unarchiveSession(id)
      this.set({ notice: { key: 'archive.restored', params: { title } } })
    } catch (error) {
      this.set({ failure: { sessionId: id, message: { text: errMsg(error) } } })
    } finally {
      this.working = false
      this.set({ restoring: null })
    }
  }

  /** 永久删除一个归档会话的日志文件并清除归档条目；成功后全量刷新官方会话列表。 */
  async remove(id: SessionId, title: string): Promise<void> {
    if (this.working) return
    this.set({ pendingDelete: null, failure: null, notice: null })
    const current = this.workspaces.list.getSnapshot()
    if (current.phase !== 'ready' || current.state !== 'idle') {
      this.set({
        failure: {
          sessionId: id,
          message:
            current.error === null
              ? { key: 'archive.unavailable' }
              : { text: `${current.error.code}: ${current.error.message}` },
        },
      })
      return
    }
    if (!current.archivedSessionIds.includes(id)) {
      this.set({ notice: { key: 'archive.alreadyRestored', params: { title } } })
      return
    }
    this.working = true
    this.set({ deleting: id })
    try {
      const result = await deleteArchivedSession(id)
      if (result.archiveClearError !== undefined) {
        this.set({
          failure: {
            sessionId: id,
            message: { key: 'archive.archiveClearFailed', params: { detail: result.archiveClearError } },
          },
        })
        return
      }
      // 宿主没有删除契约，也不广播会话移除；归档条目清除后侧栏立即解除隐藏，
      // 官方会话列表里的过期摘要会让会话看似复活到重启为止，必须主动全量刷新。
      try {
        await this.refreshSessions()
      } catch (error) {
        this.set({
          failure: {
            sessionId: id,
            message: { key: 'archive.refreshFailed', params: { detail: errMsg(error) } },
          },
        })
      }
      this.set({
        notice: result.filesRemoved
          ? { key: 'archive.deleted', params: { title } }
          : { key: 'archive.deletedNoFiles', params: { title } },
      })
    } catch (error) {
      this.set({ failure: { sessionId: id, message: { text: errMsg(error) } } })
    } finally {
      this.working = false
      this.set({ deleting: null })
    }
  }
}
