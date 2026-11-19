import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：main / sidebar.panellist 槽位契约、ctx.slots / ctx.sessions / ctx.locale
// 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { McpPanelIcon } from './client/McpPanelIcon'
import { McpPanelPage, type McpPanelInjected } from './client/McpPanelPage'
import { NS, en, zh } from './client/locales'
import { McpStore } from './client/store'
import { mcpApi } from './client/api'

/** 全局面板 id：侧栏入口（sidebar.panellist）与中栏页面（main keyed）同 id 关联。 */
const MCP_PANEL_ID = 'dsh-mcp'

export const inject: string[] = [
  'slots',
  // 工作区档（<cwd>/.mcp.json）跟随主视图会话，cwd 事实源在会话列表快照。
  'sessions',
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-mcp: copy dictionaries')
  // 侧栏入口 label thunk 用 apply 域绑定；页面的 t 由注册声明 locale 命名空间
  // 获得框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  const store = new McpStore()
  const injected: McpPanelInjected = { store }

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

  // 全局面板：清单页是日常打开的工作面，不占设置页一级导航；点击侧栏入口
  // 由侧栏外壳调 layout.selectPanel 打开，插件不自管导航。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: MCP_PANEL_ID,
        locale: NS,
        inject: (): McpPanelInjected => injected,
      },
      McpPanelPage,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: MCP_PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('section.label'),
      },
      McpPanelIcon,
    ),
  )
}
