import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { NoticeRelay, type Notice } from './notice-relay'

const NOTICE_HOLD_MS = 5000

/**
 * 订阅通知通道并持组件态：随分区卸载消亡，未展示完的通知不在重开分区时重放。
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
