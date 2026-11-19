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
 * 一次性通知的壳层常驻显示点（官方 plugin-manager 的 PluginRefreshToast 先例）：
 * 挂在常驻的 shell.overlay 上，操作与事件通知（连接 / 同步生命周期、保存 / 删除 /
 * 表单测试）发生即显示、onDone 经 dismissNotice 清空——显示点永不卸载，触发面
 * （面板 / 弹窗）关闭前后完成的反馈都能播完，无残留无重放。
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
