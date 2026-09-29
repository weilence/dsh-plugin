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
