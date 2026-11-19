import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：plugins.bundle.config 与 shell.overlay 槽位契约、ctx.slots / ctx.locale /
// ctx.sessions 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { ResidentNoticeSlotEntry } from '@dsh-plugins/client-ui'
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

  // 面板挂自家 bundle 详情页（keyed by 包名）：装了插件点开卡片即见面板，
  // 不再占设置页一级导航。
  ctx.slots.inject('plugins.bundle.config', () => {
    return ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: '@weilence/dsh-gitlab',
        locale: NS,
        inject: () => injected,
      },
      SitesSection,
    )
  })
  // 一次性通知的常驻显示点：面板内不渲染 Toast，反馈在触发面（详情页）关闭前后都能播完。
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-gitlab.notices',
        inject: () => ({ relay: store.notices }),
      },
      ResidentNoticeSlotEntry,
    ),
  )
}
