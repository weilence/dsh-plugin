import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section / tool.call.toolview 槽位契约与 ctx.slots /
// ctx.locale / ctx.sessions 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { TOOL_CONF_GET_PAGE, TOOL_CONF_SEARCH, TOOL_JIRA_GET_ISSUE, TOOL_JIRA_SEARCH } from './shared'
import { AtlassianStore } from './client/store'
import { SitesSection, type AtlassianSectionInjected } from './client/SitesSection'
import { ConfPageCard, ConfSearchCard, JiraIssueCard, JiraSearchCard } from './client/tool-cards'
import { NS, en, zh } from './client/locales'
import { atlassianApi } from './client/api'

export const inject: string[] = [
  'slots',
  'locale',
  // 工作区关联跟随主视图会话，cwd 事实源在官方 sessions.list 快照。
  'sessions',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-atlassian: copy dictionaries')
  // 导航 label thunk 用 apply 域绑定；面板的 t 由注册声明 locale 命名空间获得
  // 框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  const store = new AtlassianStore()
  const injected: AtlassianSectionInjected = { store }

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

  // cwd 变化即上报 host（工作区关联事实源）；上报失败静默——面板打开时的
  // 每次 list 都带 cwd，可兜底（dsh-mcp 同模式）。
  const report = (): void => {
    const cwd = mainWorkspaceCwd()
    store.setWorkspaceCwd(cwd)
    void atlassianApi.reportCwd({ cwd }).catch(() => {})
  }
  report()
  ctx.effect(() => ctx.sessions.list.subscribe(report), 'dsh-atlassian: workspace cwd bridge')

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-atlassian',
        order: 42,
        label: () => t('section.label'),
        locale: NS,
        inject: () => injected,
      },
      SitesSection,
    )
  })

  // 工具卡片按 wire 名分发：四个只读工具各占一个 keyed 视图，未注册名回落宿主通用卡。
  const toolViews = [
    [TOOL_JIRA_SEARCH, JiraSearchCard],
    [TOOL_JIRA_GET_ISSUE, JiraIssueCard],
    [TOOL_CONF_SEARCH, ConfSearchCard],
    [TOOL_CONF_GET_PAGE, ConfPageCard],
  ] as const
  for (const [key, component] of toolViews) {
    ctx.slots.inject('tool.call.toolview', () =>
      ctx.slots.register({ name: 'tool.call.toolview', key }, component),
    )
  }
}
