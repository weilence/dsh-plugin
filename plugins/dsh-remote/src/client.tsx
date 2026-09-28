/**
 * dsh-remote client half：注册设置页「远程开发」菜单页。
 *
 * host half（src/index.ts）必须是真实插件行（浏览器插件名录由
 * dsh-client-modules 扫描宿主 Loader 中已激活条目的 dsh.client 声明
 * 生成），本半侧经 slots 注入 settings.section。面板数据全部来自 host
 * 桥（连接库 + 轮询的运行态快照 + 本机清单），无客户端独立状态源。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteSection, type RemotePanelEnv } from './client/RemoteSection'
import { RemoteStore } from './client/store'

export const inject: string[] = ['slots']

export function apply(ctx: ClientContext) {
  const store = new RemoteStore()
  const env: RemotePanelEnv = { store }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-remote',
        order: 42,
        label: () => '远程开发',
        inject: (): RemotePanelEnv => env,
      },
      RemoteSection,
    )
  })
}
