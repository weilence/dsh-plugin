/** 事件 toast 的壳层常驻显示点：自动恢复 / 自动重连 / 同步结果经 store 的
 *  toast 通道在此渲染，面板内不再渲染 Toast（见根 docs/panel.md「面板交互约定」）。
 */
import { ResidentNoticeToast } from '@dsh-plugins/client-ui'
import type { NoticeRelay } from '@dsh-plugins/client-ui/notice-relay'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { messageText, type NS, type PanelMessage } from './locales'

/** 注册方注入面（client.tsx 装配，slot inject 回调提供）。 */
export interface RemoteNoticesToastInjected {
  relay: NoticeRelay<PanelMessage>
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type RemoteNoticesToastProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> &
  InjectFace<RemoteNoticesToastInjected>

export function RemoteNoticesToast(props: RemoteNoticesToastProps) {
  return <ResidentNoticeToast relay={props.relay} text={(message) => messageText(message, props.t)} />
}
