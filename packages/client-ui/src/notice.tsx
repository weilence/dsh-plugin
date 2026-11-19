import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
// Type-only：shell.overlay 槽位契约（PropsRuntime 的 SlotMap 声明合并）。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NoticeRelay, type Notice } from './notice-relay'

const NOTICE_HOLD_MS = 5000

/**
 * 订阅通知通道并持组件态：`ResidentNoticeToast` 的内部构件——owner 是常驻显示点，
 * 通道投递即换 nonce 显示，dismiss 清空后无残留无重放。
 */
export function useNotice<M>(relay: NoticeRelay<M>): { notice: Notice<M> | null; dismiss: () => void } {
  const [state, setState] = useState<{ notice: Notice<M> | null }>({ notice: null })
  useEffect(
    () =>
      relay.subscribe((message) => {
        setState((previous) => ({ notice: { message, nonce: (previous.notice?.nonce ?? 0) + 1 } }))
      }),
    [relay],
  )
  const dismiss = useCallback(() => {
    setState((current) => (current.notice === null ? current : { notice: null }))
  }, [])
  return { notice: state.notice, dismiss }
}

/** 一次性通知的显示窗：官方 Toast，notice 为 null 不渲染；holdMs 缺省 5000（仓库统一横幅时长）。 */
export function NoticeToast<M>(props: {
  notice: Notice<M> | null
  text: (message: M) => string
  holdMs?: number
  onDismiss: () => void
}): ReactNode | null {
  if (props.notice === null) return null
  return (
    <Toast
      key={props.notice.nonce}
      text={props.text(props.notice.message)}
      holdMs={props.holdMs ?? NOTICE_HOLD_MS}
      onDone={props.onDismiss}
    />
  )
}

/**
 * 常驻通知显示点：挂在宿主壳层 `shell.overlay` 槽位等页面级常驻位置使用——owner 不随
 * 触发面（面板 / 弹窗）卸载，触发面关闭前后完成的反馈都能播完横幅；onDone 清空，
 * 无残留无重放。仓库约定所有 Toast 一律经常驻显示点显示，面板 / 弹窗内不再渲染
 * Toast（通道划分见根 docs/panel.md；官方 plugin-manager 的 PluginRefreshToast 先例）。
 */
export function ResidentNoticeToast<M>(props: {
  relay: NoticeRelay<M>
  text: (message: M) => string
  holdMs?: number
}): ReactNode | null {
  const { notice, dismiss } = useNotice(props.relay)
  return <NoticeToast notice={notice} text={props.text} holdMs={props.holdMs} onDismiss={dismiss} />
}

/**
 * 纯文本通道的现成常驻条目：消息在 emit 时已按事件时间取词定格，条目自身不需要
 * locale seat——注册 `shell.overlay` 槽位并以注入面提供 `relay` 即可直接使用。
 * 描述子型通道（`{key, params}` 需按插件命名空间渲染期取词）需要插件自己的窄 t
 * 类型解析，保留各自 wrapper；通道划分见根 docs/panel.md。
 */
export function ResidentNoticeSlotEntry(
  props: PropsRuntime<'shell.overlay'> & InjectFace<{ relay: NoticeRelay<string> }>,
): ReactNode | null {
  return <ResidentNoticeToast relay={props.relay} text={(message) => message} />
}
