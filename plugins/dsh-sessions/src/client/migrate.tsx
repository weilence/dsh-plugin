/**
 * 「迁移到工作区」弹窗：shell.overlay 常驻条目持有弹窗——
 * 行随菜单关闭而卸载，弹窗必须挂在行外；请求经 requests 桥送达。
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { migrateSessionToWorkspace } from './api'
import { useLoadProbe } from './loaded'
import { messageText, NS, type Message, type SessionsT } from './locales'
import type { RequestsBridge, SessionDialogRequest } from './requests'
import localStyles from '../client.module.css'

const styles = { ...sharedStyles, ...localStyles }

/** 与官方设置份额 useWorkspaces 同一只读口径的钩子工厂，经注入面携带。 */
export function workspaceSnapshotHook(workspaces: IWorkspaces): () => WorkspaceSnapshot {
  return () =>
    useSyncExternalStore(
      (listener) => workspaces.list.subscribe(listener),
      () => workspaces.list.getSnapshot(),
    )
}

/** shell.overlay 注入面里迁移弹窗需要的份额；弹窗分发宿主见 dialogs.tsx。 */
export interface MigrateDialogInjected {
  bridge: RequestsBridge
  // 命名避开全局标准席位的 useWorkspaces 选择器钩子，注入面保持自有事实源。
  useWorkspaceList: () => WorkspaceSnapshot
  refreshSessions: () => Promise<void>
  /** 官方被动探针：true = 会话已加载在宿主内存；失败上抛，弹窗按「未知」放行。 */
  probeSessionLoaded: (sessionId: SessionId, signal?: AbortSignal) => Promise<boolean>
}

type MigrateDialogProps = {
  t: SessionsT
  target: Pick<SessionDialogRequest, 'sessionId' | 'title'>
  useWorkspaceList: () => WorkspaceSnapshot
  refreshSessions: () => Promise<void>
  probeSessionLoaded: (sessionId: SessionId, signal?: AbortSignal) => Promise<boolean>
  /** 上报成功结果：常驻条目据此弹出成功横幅并关闭弹窗（含归属未完成的补救指引）。 */
  onSuccess: (message: Message) => void
  onClose: () => void
}

export function MigrateDialog({
  t,
  target,
  useWorkspaceList,
  refreshSessions,
  probeSessionLoaded,
  onSuccess,
  onClose,
}: MigrateDialogProps) {
  const snapshot = useWorkspaceList()
  // 已加载闸门：probing 期间禁用提交，loaded 禁用并给行内原因，探测失败按「未知」放行。
  const loadPhase = useLoadProbe(probeSessionLoaded, target.sessionId)
  const [workspaceId, setWorkspaceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Message | null>(null)
  const working = useRef(false)
  const ready = snapshot.phase === 'ready' && snapshot.state === 'idle'
  const targetWorkspace = snapshot.items.find((workspace) => workspace.workspaceId === workspaceId)
  // 成员资格按工作目录派生：当前所在工作区不是合法目标，从选择里排除。
  const current = snapshot.items.find((workspace) => workspace.sessionIds.includes(target.sessionId))
  const choices = snapshot.items.filter((workspace) => workspace !== current)
  const loadBlocked = loadPhase === 'probing' || loadPhase === 'loaded'

  const submit = async () => {
    if (working.current || workspaceId === '' || loadBlocked) return
    if (!ready || targetWorkspace === undefined) {
      setNotice({ key: 'workspace.unavailable' })
      return
    }
    working.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await migrateSessionToWorkspace(target.sessionId, workspaceId)
      // 成功家族（含归属未完成的补救指引）都走横幅并关弹窗；仅刷新列表失败时换文案。
      let outcome: Message =
        result.membershipPending !== undefined
          ? { text: result.membershipPending }
          : result.moved
            ? { key: 'migrate.done', params: { title: target.title, workspace: targetWorkspace.title } }
            : { key: 'migrate.attached', params: { title: target.title, workspace: targetWorkspace.title } }
      try {
        await refreshSessions()
      } catch (error) {
        outcome = { key: 'migrate.refreshFailed', params: { detail: errMsg(error) } }
      }
      onSuccess(outcome)
    } catch (error) {
      // 失败行内常驻（不随时间消失），弹窗保持打开供直接重试；重试或改选时清空。
      setNotice({ text: errMsg(error) })
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={t('migrate.title')}
      closeLabel={t('close')}
      onClose={() => {
        if (!working.current) onClose()
      }}
      className={styles.dialog}
      footer={
        <div className={styles.footer}>
          <div className={styles.feedback} aria-live="polite">
            {/* 失败与校验反馈行内常驻（不随时间消失，重试/改选时清空）；成功走常驻条目的横幅并关闭弹窗。 */}
            {notice !== null ? <p role="alert">{messageText(notice, t)}</p> : null}
            {busy ? <p role="status">{t('migrate.working')}</p> : null}
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !ready || targetWorkspace === undefined || loadBlocked}
              onClick={() => void submit()}
            >
              {t('migrate.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      <div className={styles.fields}>
        <p className={styles.warning}>{t('migrate.description')}</p>
        {loadPhase === 'probing' ? <p role="status">{t('session.probeLoading')}</p> : null}
        {loadPhase === 'loaded' ? <p role="alert">{t('session.loadedBlocking')}</p> : null}
        <label>
          {t('workspace')}
          <select
            data-modal-autofocus
            value={workspaceId}
            disabled={busy || !ready}
            onChange={(event) => {
              setWorkspaceId(event.target.value)
              setNotice(null)
            }}
          >
            <option value="">{t('workspace.choose')}</option>
            {choices.map((workspace) => (
              <option key={workspace.workspaceId} value={workspace.workspaceId}>
                {workspace.title} — {workspace.path}
              </option>
            ))}
          </select>
        </label>
        {snapshot.error !== null ? (
          <p role="alert">
            {snapshot.error.code}: {snapshot.error.message}
          </p>
        ) : snapshot.phase === 'pending' || snapshot.state === 'loading' ? (
          <p role="status">{t('workspace.loading')}</p>
        ) : ready && current !== undefined && choices.length === 0 ? (
          <p>{t('migrate.noTarget')}</p>
        ) : current !== undefined ? (
          <p>
            {t('migrate.current')}: {current.title} — {current.path}
          </p>
        ) : null}
        {targetWorkspace !== undefined ? <code className={styles.path}>{targetWorkspace.path}</code> : null}
      </div>
    </Modal>
  )
}
