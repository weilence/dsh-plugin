/**
 * 会话行「迁移到工作区」：菜单条目发起请求，shell.overlay 常驻条目持有弹窗——
 * 行随菜单关闭而卸载，弹窗必须挂在行外；两者经本模块的桥共享请求。
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import { Button, MenuItemButton, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { errMsg } from '@dsh-plugins/shared'
import sharedStyles from '@dsh-plugins/client-ui/styles'
import { migrateSessionToWorkspace } from './api'
import { messageText, NS, type Message, type SessionsT } from './locales'
import localStyles from '../client.module.css'

const styles = { ...sharedStyles, ...localStyles }

export interface MigrateTarget {
  sessionId: SessionId
  title: string
}

export function createMigrateBridge() {
  let request: MigrateTarget | null = null
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => request,
    open: (target: MigrateTarget) => {
      request = target
      listeners.forEach((listener) => listener())
    },
    close: () => {
      request = null
      listeners.forEach((listener) => listener())
    },
  }
}

export type MigrateBridge = ReturnType<typeof createMigrateBridge>

/** 与官方设置份额 useWorkspaces 同一只读口径的钩子工厂，经注入面携带。 */
export function workspaceSnapshotHook(workspaces: IWorkspaces): () => WorkspaceSnapshot {
  return () =>
    useSyncExternalStore(
      (listener) => workspaces.list.subscribe(listener),
      () => workspaces.list.getSnapshot(),
    )
}

export interface MigrateMenuItemInjected {
  requestMigrate: (target: MigrateTarget) => void
}
type MigrateMenuItemProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> &
  PropsLocale<typeof NS> &
  InjectFace<MigrateMenuItemInjected>

export function MigrateMenuItem({
  sessionId,
  displayTitle,
  useMenuOpenState,
  requestMigrate,
  t,
}: MigrateMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      separatorBefore
      onSelect={() => {
        setMenuOpen(false)
        requestMigrate({ sessionId, title: displayTitle })
      }}
    >
      {t('migrate')}
    </MenuItemButton>
  )
}

export interface MigrateDialogInjected {
  bridge: MigrateBridge
  // 命名避开全局标准席位的 useWorkspaces 选择器钩子，注入面保持自有事实源。
  useWorkspaceList: () => WorkspaceSnapshot
  refreshSessions: () => Promise<void>
}
type MigrateDialogEntryProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> &
  InjectFace<MigrateDialogInjected>

export function MigrateDialogEntry({
  bridge,
  useWorkspaceList,
  refreshSessions,
  t,
}: MigrateDialogEntryProps) {
  const request = useSyncExternalStore(bridge.subscribe, bridge.get)
  if (request === null) return null
  return (
    <MigrateDialog
      key={request.sessionId}
      t={t}
      target={request}
      useWorkspaceList={useWorkspaceList}
      refreshSessions={refreshSessions}
      onClose={bridge.close}
    />
  )
}

type MigrateDialogProps = {
  t: SessionsT
  target: MigrateTarget
  useWorkspaceList: () => WorkspaceSnapshot
  refreshSessions: () => Promise<void>
  onClose: () => void
}

function MigrateDialog({ t, target, useWorkspaceList, refreshSessions, onClose }: MigrateDialogProps) {
  const snapshot = useWorkspaceList()
  const [workspaceId, setWorkspaceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Message | null>(null)
  const working = useRef(false)
  const ready = snapshot.phase === 'ready' && snapshot.state === 'idle'
  const targetWorkspace = snapshot.items.find((workspace) => workspace.workspaceId === workspaceId)
  // 成员资格按工作目录派生：当前所在工作区不是合法目标，从选择里排除。
  const current = snapshot.items.find((workspace) => workspace.sessionIds.includes(target.sessionId))
  const choices = snapshot.items.filter((workspace) => workspace !== current)

  const submit = async () => {
    if (working.current || workspaceId === '') return
    if (!ready || targetWorkspace === undefined) {
      setNotice({ key: 'workspace.unavailable' })
      return
    }
    working.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await migrateSessionToWorkspace(target.sessionId, workspaceId)
      setNotice(
        result.membershipPending !== undefined
          ? { text: result.membershipPending }
          : result.moved
            ? { key: 'migrate.done', params: { title: target.title, workspace: targetWorkspace.title } }
            : { key: 'migrate.attached', params: { title: target.title, workspace: targetWorkspace.title } },
      )
      try {
        await refreshSessions()
      } catch (error) {
        setNotice({ key: 'migrate.refreshFailed', params: { detail: errMsg(error) } })
      }
    } catch (error) {
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
            {/* 提示信息统一走 notice（官方 Toast，z-1100 盖过 Modal 的 1000 遮罩）；成功与失败同流。 */}
            {notice !== null ? (
              <Toast
                key={messageText(notice, t)}
                text={messageText(notice, t)}
                holdMs={5000}
                onDone={() => setNotice(null)}
              />
            ) : null}
            {busy ? <p role="status">{t('migrate.working')}</p> : null}
          </div>
          <div className={styles.actions}>
            <Button variant="outline" disabled={busy} onClick={onClose}>
              {t('close')}
            </Button>
            <Button
              variant="primary"
              disabled={busy || !ready || targetWorkspace === undefined}
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
