import type { Context } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only：ctx.remote 的 session 生成面（含 state 探针）声明合并。
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only：shell.overlay 槽位契约与 useSessions 等 GlobalStandardProps 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionDialogsEntry, type SessionDialogsInjected } from './client/dialogs'
import { workspaceSnapshotHook } from './client/migrate'
import { SessionMenuItems, type SessionMenuInjected } from './client/menu'
import { NS, en, zh } from './client/locales'
import { createRequestsBridge } from './client/requests'

export const inject = ['slots', 'locale', 'sessions', 'workspaces']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-sessions: locale')
  // 两个 half 的同名 sessions 在联合类型检查中相遇；浏览器入口只持有官方 ISessions。
  const sessions = ctx.sessions as unknown as ISessions
  // 官方被动探针：session.state 的 active ⇔ 宿主为该会话持有活 agent，与守卫所查的
  // 官方 SessionStore 同源等价；读取本身不激活会话。失败上抛，弹窗按「未知」放行。
  const probeSessionLoaded = async (sessionId: SessionId, signal?: AbortSignal): Promise<boolean> => {
    const result = await ctx.remote.session.state({ sessionId }, signal)
    if (!result.ok) throw result.error
    return result.value.active
  }
  // 菜单条目发起弹窗请求，shell.overlay 常驻条目持有弹窗——行随菜单关闭卸载，弹窗必须挂在行外。
  const bridge = createRequestsBridge()
  ctx.slots.inject('sidebar.workspaces.session.menu.item', () =>
    ctx.slots.register(
      {
        name: 'sidebar.workspaces.session.menu.item',
        id: 'dsh-sessions.session-menu',
        order: 500,
        locale: NS,
        inject: (): SessionMenuInjected => ({
          open: (request) => {
            bridge.open(request)
          },
        }),
      },
      SessionMenuItems,
    ),
  )
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-sessions.dialogs',
        locale: NS,
        inject: (): SessionDialogsInjected => ({
          bridge,
          useWorkspaceList: workspaceSnapshotHook(ctx.workspaces),
          refreshSessions: () => sessions.refresh(),
          probeSessionLoaded,
        }),
      },
      SessionDialogsEntry,
    ),
  )
}
