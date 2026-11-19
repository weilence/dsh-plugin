/**
 * shell.overlay 常驻弹窗宿主：迁移 / 预设两种请求的弹窗分发——
 * 行随菜单关闭而卸载，弹窗必须挂在行外；各弹窗自带反馈（Toast），无需额外通知通道。
 */
import { useSyncExternalStore } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MigrateDialog, workspaceSnapshotHook } from './migrate'
import { NS } from './locales'
import { PresetDialog } from './preset'
import type { RequestsBridge } from './requests'

/** shell.overlay 注入面：请求桥与迁移弹窗的工作区快照钩子。 */
export interface SessionDialogsInjected {
  bridge: RequestsBridge
  // 命名避开全局标准席位的 useWorkspaces 选择器钩子，注入面保持自有事实源。
  useWorkspaceList: ReturnType<typeof workspaceSnapshotHook>
  refreshSessions: () => Promise<void>
}

type SessionDialogsEntryProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> &
  InjectFace<SessionDialogsInjected>

export function SessionDialogsEntry({
  bridge,
  useWorkspaceList,
  refreshSessions,
  t,
}: SessionDialogsEntryProps) {
  const request = useSyncExternalStore(bridge.subscribe, bridge.get)
  if (request === null) return null
  if (request.kind === 'migrate') {
    return (
      <MigrateDialog
        key={`${request.kind}:${request.sessionId}`}
        t={t}
        target={request}
        useWorkspaceList={useWorkspaceList}
        refreshSessions={refreshSessions}
        onClose={bridge.close}
      />
    )
  }
  return (
    <PresetDialog
      key={`${request.kind}:${request.sessionId}`}
      t={t}
      target={request}
      onClose={bridge.close}
    />
  )
}
