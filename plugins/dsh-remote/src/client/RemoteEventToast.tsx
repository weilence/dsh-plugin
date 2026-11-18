import { useSyncExternalStore } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { messageText, type NS } from './locales'
import type { RemoteStore } from './store'

/** 注册方注入面（client.tsx 装配，slot inject 回调提供）。 */
export interface RemoteEventToastInjected {
  store: RemoteStore
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type RemoteEventToastProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> &
  InjectFace<RemoteEventToastInjected>

/**
 * 事件类一次性通知的壳层显示点（官方 plugin-manager 的 PluginRefreshToast 先例）：
 * 挂在常驻的 shell.overlay 上，连接 / 同步等生命周期事件发生即显示、onDone 经
 * dismissNotice 清空——显示点永不卸载，notice 无残留无重放，与面板内操作反馈
 * （NoticeToast）分流。
 */
export function RemoteEventToast(props: RemoteEventToastProps) {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  if (state.notice === null) return null
  return (
    <Toast
      key={state.noticeSeq}
      text={messageText(state.notice, t)}
      holdMs={5000}
      onDone={() => store.dismissNotice()}
    />
  )
}
