/** 一次性通知的壳层常驻显示点：面板内不再渲染 Toast，操作反馈统一在此显示（见仓库根 docs/panel.md）。 */
import { ResidentNoticeToast } from '@dsh-plugins/client-ui'
import type { NoticeRelay } from '@dsh-plugins/client-ui/notice-relay'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { messageText, type NS, type PanelMessage } from './locales'

/** 注册方注入面（client.tsx 装配，slot inject 回调提供）。 */
export interface McpNoticesInjected {
  relay: NoticeRelay<PanelMessage>
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type McpNoticesToastProps = PropsRuntime<'shell.overlay'> &
  PropsLocale<typeof NS> &
  InjectFace<McpNoticesInjected>

export function McpNoticesToast(props: McpNoticesToastProps) {
  return <ResidentNoticeToast relay={props.relay} text={(message) => messageText(message, props.t)} />
}
