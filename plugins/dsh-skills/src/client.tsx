import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots / ctx.sessions / ctx.locale 的
// Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SkillsSection, type SkillsPanelEnv } from './client/SkillsSection'
import { SkillsStore } from './client/store'
import { NS, en, zh } from './client/locales'

export const inject: string[] = [
  'slots',
  'sessions',
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skills: copy dictionaries')
  // 导航 label thunk 与面板注入面共用一个绑定取词函数：调用时读取当前
  // 语言，新鲜度由 locale revision 驱动的 outlet 重绘保证。
  const t = ctx.locale.bind(NS)
  const store = new SkillsStore(t)

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

  const env: SkillsPanelEnv = {
    store,
    workspace: {
      getSnapshot: mainWorkspaceCwd,
      subscribe: (listener: () => void): (() => void) => ctx.sessions.list.subscribe(listener),
    },
    t,
  }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-skills',
        order: 40,
        label: () => t('section.label'),
        inject: (): SkillsPanelEnv => env,
      },
      SkillsSection,
    )
  })
}
