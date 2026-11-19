import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约与 ctx.slots / ctx.locale / ctx.sessions
// 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { NS, en, zh } from './client/locales'
import { SitesSection, type GitlabSectionInjected } from './client/SitesSection'
import { GitlabStore } from './client/store'
import { gitlabApi } from './client/api'

export const inject: string[] = [
  'slots',
  'locale',
  // 工作区关联跟随主视图会话，cwd 事实源在官方 sessions.list 快照。
  'sessions',
]

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-gitlab: copy dictionaries')
  // 导航 label thunk 用 apply 域绑定；面板的 t 由注册声明 locale 命名空间获得
  // 框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  const store = new GitlabStore()
  const injected: GitlabSectionInjected = { store }

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
    void gitlabApi.reportCwd({ cwd }).catch(() => {})
  }
  report()
  ctx.effect(() => ctx.sessions.list.subscribe(report), 'dsh-gitlab: workspace cwd bridge')

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-gitlab',
        order: 43,
        label: () => t('section.label'),
        locale: NS,
        inject: () => injected,
      },
      SitesSection,
    )
  })
}
