/** 会话行「…」菜单条目：迁移到工作区 / 迁移预设；弹窗请求经桥交给 shell.overlay 常驻条目。 */
import {
  IconAgentPresetOutlineRegular,
  IconWorkspaceTreeOutlineRegular,
  MenuItemButton,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales'
import type { SessionDialogRequest } from './requests'

/** 菜单条目的注入面：弹窗请求出口（弹窗本体挂在 shell.overlay，不随菜单关闭卸载）。 */
export interface SessionMenuInjected {
  open: (request: SessionDialogRequest) => void
}

type SessionMenuItemsProps = PropsRuntime<'sidebar.workspaces.session.menu.item'> &
  PropsLocale<typeof NS> &
  InjectFace<SessionMenuInjected>

export function SessionMenuItems({
  sessionId,
  displayTitle,
  useMenuOpenState,
  useSessions,
  open,
  t,
}: SessionMenuItemsProps) {
  // 行菜单打开即重渲染：此处读官方会话快照做前置闸门（子会话禁用；running 或本客户端
  // 持有引用时必然已加载，同样禁用）。快照未及加载或盲区（已加载但空闲且未被本客户端
  // 持有）时条目保持可用，弹窗探针与 host 侧守卫仍会拦——客户端闸门只是前置反馈。
  const summary = useSessions((value) => value.byId[sessionId])
  const [, setMenuOpen] = useMenuOpenState()
  // 官方行身份的 displayTitle 无标题时为空串；弹窗标题与会话 ID 兜底。
  const title = displayTitle !== '' ? displayTitle : sessionId
  const retained = Object.values(summary?.retainedBy ?? {}).some((count) => count > 0)
  const loaded = summary?.running === true || retained
  const request = (kind: SessionDialogRequest['kind']): void => {
    setMenuOpen(false)
    open({ kind, sessionId, title })
  }
  const subagent = summary?.origin === 'subagent'
  return (
    <>
      <MenuItemButton
        separatorBefore
        icon={<IconWorkspaceTreeOutlineRegular />}
        disabled={subagent || loaded}
        disabledReason={subagent ? t('migrate.disabledSubagent') : t('session.loadedBlocking')}
        onSelect={() => request('migrate')}
      >
        {t('menu.migrate')}
      </MenuItemButton>
      <MenuItemButton
        icon={<IconAgentPresetOutlineRegular />}
        disabled={subagent || loaded}
        disabledReason={subagent ? t('preset.disabledSubagent') : t('session.loadedBlocking')}
        onSelect={() => request('preset')}
      >
        {t('menu.preset')}
      </MenuItemButton>
    </>
  )
}
