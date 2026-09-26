/**
 * dsh-skills client half：注册设置页「Skills 管理」菜单页。
 *
 * host half（src/index.ts）必须是真实插件行（浏览器插件名录由
 * dsh-client-modules 扫描宿主 Loader 中已激活条目的 dsh.client 声明
 * 生成），本半侧经 slots 注入 settings.section。当前工作区 = 主视图会话
 * （sessions 快照里 retainedBy.mainView > 0）的 cwd，作为可订阅源供面板
 * 跟随；管理范围固定为「当前工作区 + 用户级」两档，不提供任意目录选择。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots / ctx.sessions 的
// Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { SkillsSection, type SkillsPanelEnv } from './client/SkillsSection'
import { SkillsStore } from './client/store'

export const inject: string[] = ['slots', 'sessions']

interface SessionsSnapshot {
  byId: Readonly<Record<string, { cwd?: unknown; retainedBy?: { mainView?: unknown } }>>
}

interface SessionsListLike {
  getSnapshot(): SessionsSnapshot
  subscribe(listener: () => void): () => void
}

export function apply(ctx: ClientContext) {
  const store = new SkillsStore()

  // 主视图会话的工作目录；快照读取全部防御式，容忍版本偏差。
  const sessionsList = (): SessionsListLike | undefined => {
    try {
      const list = (ctx.sessions as { list?: SessionsListLike }).list
      return typeof list?.getSnapshot === 'function' ? list : undefined
    } catch {
      return undefined
    }
  }
  const mainWorkspaceCwd = (): string | undefined => {
    const list = sessionsList()
    if (list === undefined) return undefined
    try {
      const byId = list.getSnapshot().byId
      for (const row of Object.values(byId)) {
        if (((row?.retainedBy?.mainView ?? 0) as number) > 0) {
          const cwd = row.cwd
          return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  const env: SkillsPanelEnv = {
    store,
    workspace: {
      getSnapshot: mainWorkspaceCwd,
      subscribe: (listener: () => void): (() => void) => {
        const list = sessionsList()
        return list === undefined ? () => {} : list.subscribe(listener)
      },
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
