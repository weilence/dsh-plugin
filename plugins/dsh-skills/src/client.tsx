import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：main / sidebar.panellist 槽位契约、ctx.slots / ctx.sessions / ctx.locale
// 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { SkillsPanelIcon } from './client/SkillsPanelIcon'
import { SkillsPanelPage, type SkillsPanelInjected } from './client/SkillsPanelPage'
import { SkillsStore } from './client/store'
import { NS, en, zh } from './client/locales'

/** 全局面板 id：侧栏入口（sidebar.panellist）与中栏页面（main keyed）同 id 关联。 */
const SKILLS_PANEL_ID = 'dsh-skills'

export const inject: string[] = [
  'slots',
  'sessions',
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  'locale',
]

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-skills: copy dictionaries')
  // 侧栏入口 label thunk 与 store 即显 notice 用 apply 域绑定；页面的 t 由注册
  // 声明 locale 命名空间获得框架标准 seat（每个语言切换换新引用）。
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

  const injected: SkillsPanelInjected = {
    store,
    workspace: {
      getSnapshot: mainWorkspaceCwd,
      subscribe: (listener: () => void): (() => void) => ctx.sessions.list.subscribe(listener),
    },
  }

  // 全局面板：清单页是日常打开的工作面，不占设置页一级导航；点击侧栏入口
  // 由侧栏外壳调 layout.selectPanel 打开，插件不自管导航。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: SKILLS_PANEL_ID,
        locale: NS,
        inject: (): SkillsPanelInjected => injected,
      },
      SkillsPanelPage,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: SKILLS_PANEL_ID,
        order: 30,
        locale: NS,
        label: () => t('section.label'),
      },
      SkillsPanelIcon,
    ),
  )
}
