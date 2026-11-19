import { IconGlobeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** 侧栏「远程开发」入口图标：只按侧栏请求的尺寸渲染字形，按钮与无障碍名由侧栏外壳负责。 */
export function RemotePanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconGlobeOutlineRegular size={size} />
}
