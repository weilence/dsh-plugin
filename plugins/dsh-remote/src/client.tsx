import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：main / sidebar.panellist 与 shell.overlay 槽位契约、ctx.slots 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { NS, en, zh, type RemoteT } from './client/locales'
import { RemoteNoticesToast, type RemoteNoticesToastInjected } from './client/RemoteNoticesToast'
import { RemotePanelIcon } from './client/RemotePanelIcon'
import { RemotePanelPage, type RemotePanelInjected } from './client/RemotePanelPage'
import { RemoteStore } from './client/store'

/** 全局面板 id：侧栏入口（sidebar.panellist）与中栏页面（main keyed）同 id 关联。 */
const REMOTE_PANEL_ID = 'dsh-remote'

export const inject: string[] = ['slots', 'locale']

export function apply(ctx: ClientContext) {
  // 全部展示文案跟随宿主语言：词典注册进 locale 服务，语言环境取其服务面。
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote: copy dictionaries')
  // 侧栏入口 label thunk 用 apply 域绑定；页面的 t 由注册声明 locale 命名空间
  // 获得框架标准 seat（每个语言切换换新引用，memo 组件靠浅比较自动刷新）。
  const t = ctx.locale.bind(NS)
  const store = new RemoteStore()
  const injected: RemotePanelInjected = { store }

  // 全局面板：连接管理是日常打开的工作面，不占设置页一级导航；点击侧栏入口
  // 由侧栏外壳调 layout.selectPanel 打开，插件不自管导航。
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: REMOTE_PANEL_ID,
        locale: NS,
        inject: (): RemotePanelInjected => injected,
      },
      RemotePanelPage,
    ),
  )
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: REMOTE_PANEL_ID,
        order: 40,
        locale: NS,
        label: () => t('section.label'),
      },
      RemotePanelIcon,
    ),
  )
  // 事件 toast 的壳层常驻显示点：官方 plugin-manager 的 PluginRefreshToast 先例
  //（shell.overlay 由 ui-layout 声明，root 作用域常驻，覆盖整个框架）。
  ctx.slots.inject('shell.overlay', () => {
    return ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-remote.event-toast',
        locale: NS,
        inject: (): RemoteNoticesToastInjected => ({ relay: store.toasts }),
      },
      RemoteNoticesToast,
    )
  })
}
