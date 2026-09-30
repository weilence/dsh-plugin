import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots / ctx.sessions 的
// Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { SkillsSection, type SkillsPanelEnv } from './client/SkillsSection'
import { SkillsStore } from './client/store'

export const inject: string[] = ['slots', 'sessions']

export function apply(ctx: ClientContext) {
  const store = new SkillsStore()

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
  }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-skills',
        order: 40,
        label: () => 'Skills 管理',
        inject: (): SkillsPanelEnv => env,
      },
      SkillsSection,
    )
  })
}
