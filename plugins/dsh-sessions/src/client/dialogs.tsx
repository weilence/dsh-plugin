/**
 * shell.overlay 常驻弹窗宿主：迁移 / 预设两种请求的弹窗分发——
 * 行随菜单关闭而卸载，弹窗必须挂在行外；成功横幅也由本条目持有（见下），失败行内常驻于弹窗。
 */
import { useSyncExternalStore, useRef, useState } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { MigrateDialog, workspaceSnapshotHook } from './migrate'
import { messageText, NS, type Message } from './locales'
import { PresetDialog } from './preset'
import type { RequestsBridge } from './requests'

/** shell.overlay 注入面：请求桥、迁移弹窗的工作区快照钩子与加载探针。 */
export interface SessionDialogsInjected {
  bridge: RequestsBridge
  // 命名避开全局标准席位的 useWorkspaces 选择器钩子，注入面保持自有事实源。
  useWorkspaceList: ReturnType<typeof workspaceSnapshotHook>
  refreshSessions: () => Promise<void>
  /** 官方被动探针：true = 会话已加载在宿主内存；失败上抛，弹窗按「未知」放行。 */
  probeSessionLoaded: (sessionId: SessionId, signal?: AbortSignal) => Promise<boolean>
}

type SessionDialogsEntryProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> &
  InjectFace<SessionDialogsInjected>

export function SessionDialogsEntry({
  bridge,
  useWorkspaceList,
  refreshSessions,
  probeSessionLoaded,
  t,
}: SessionDialogsEntryProps) {
  const request = useSyncExternalStore(bridge.subscribe, bridge.get)
  // 成功反馈的宿主必须是本条目：Toast 虽经 body portal 渲染（视觉位置与宿主无关），
  // 但 React 归属决定存活——弹窗成功后自关，横幅只有挂在不随弹窗卸载的常驻条目上才能播完
  // （官方 plugin-manager 的 PluginRefreshToast 同款模式，通道约定见仓库根 docs/panel.md）。
  const [success, setSuccess] = useState<{ nonce: number; message: Message } | null>(null)
  const nextNonce = useRef(0)
  const succeed = (message: Message): void => {
    // nonce 作 key：同文案连续两次成功也重开计时。
    setSuccess({ nonce: ++nextNonce.current, message })
    bridge.close()
  }
  const dialog =
    request === null ? null : request.kind === 'migrate' ? (
      <MigrateDialog
        key={`${request.kind}:${request.sessionId}`}
        t={t}
        target={request}
        useWorkspaceList={useWorkspaceList}
        refreshSessions={refreshSessions}
        probeSessionLoaded={probeSessionLoaded}
        onSuccess={succeed}
        onClose={bridge.close}
      />
    ) : (
      <PresetDialog
        key={`${request.kind}:${request.sessionId}`}
        t={t}
        target={request}
        probeSessionLoaded={probeSessionLoaded}
        onSuccess={succeed}
        onClose={bridge.close}
      />
    )
  return (
    <>
      {dialog}
      {success !== null ? (
        <Toast
          key={success.nonce}
          text={messageText(success.message, t)}
          tone="success"
          holdMs={5000}
          onDone={() => setSuccess(null)}
        />
      ) : null}
    </>
  )
}
