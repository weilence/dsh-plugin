import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots / ctx.sessions / ctx.locale 的
// Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { McpSection, type McpSectionInjected } from './client/McpSection'
import { NS, en, zh } from './client/locales'
import { McpStore } from './client/store'
import { mcpApi } from './client/api'

export const inject: string[] = [
  'slots',
  // 工作区档（<cwd>/.mcp.json）跟随主视图会话，cwd 事实源在会话列表快照。
  'sessions',
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp: copy dictionaries')
  // 导航 label thunk 用 apply 域绑定；面板的 t 由注册声明 locale 命名空间获得
  // 框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  const store = new McpStore()
  const injected: McpSectionInjected = { store }

  // 主视图会话的工作目录（官方 sessions.list 快照，随会话列表变化更新）。
  const mainWorkspaceCwd = (): string | undefined => {
    for (const row of Object.values(ctx.sessions.list.getSnapshot().byId)) {
      if (Number(row.retainedBy?.mainView ?? 0) > 0) {
        const cwd = row.cwd
        return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
      }
    }
    return undefined
  }

  // cwd 变化即上报 host：触发工作区档重同步（挂载 / 卸载该工作区的 MCP），
  // 同时重拉列表。上报失败静默——面板打开时的每次 list 都带 cwd，可兜底。
  const report = (): void => {
    const cwd = mainWorkspaceCwd()
    store.setWorkspaceCwd(cwd)
    void mcpApi.reportCwd({ cwd }).catch(() => {})
  }
  report()
  ctx.effect(() => ctx.sessions.list.subscribe(report), 'dsh-mcp: workspace cwd bridge')

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-mcp',
        order: 41,
        label: () => t('section.label'),
        locale: NS,
        inject: (): McpSectionInjected => injected,
      },
      McpSection,
    )
  })
}
