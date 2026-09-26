/**
 * dsh-mcp client half：注册设置页「MCP 管理」菜单页。
 *
 * host half（src/index.ts）必须是真实插件行（浏览器插件名录由
 * dsh-client-modules 扫描宿主 Loader 中已激活条目的 dsh.client 声明
 * 生成），本半侧经 slots 注入 settings.section。面板数据全部来自 host
 * 桥（两层用户 patch + Loader / 工具注册表运行态），无客户端独立状态源。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { McpSection, type McpPanelEnv } from './client/McpSection'
import { McpStore } from './client/store'

export const inject: string[] = ['slots']

export function apply(ctx: ClientContext) {
  const store = new McpStore()
  const env: McpPanelEnv = { store }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-mcp',
        order: 41,
        label: () => 'MCP 管理',
        inject: (): McpPanelEnv => env,
      },
      McpSection,
    )
  })
}
