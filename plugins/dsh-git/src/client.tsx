/** 右侧栏「Git 仓库」标签：注册标签类型与标签体。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { GuideArtworkGit } from './client/GuideArtworkGit'
import { ReposBody, type ReposBodyInjected } from './client/ReposBody'
import { en, NS, zh } from './client/locales'

/** 标签类型 kind；指南页入口按 kind 打开页面。 */
const GIT_KIND = 'git-repos'
/** 实现标识，同时是标签体在 keyed 槽位上的注册键。 */
const GIT_ID = '@weilence/dsh-git'

export const inject = ['slots', 'locale', 'sidebarRightTabs']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-git: locale')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: GIT_ID,
        kind: GIT_KIND,
        title: () => t('type.label'),
        guide: [
          {
            id: 'repos',
            order: 40,
            title: () => t('guide.title'),
            description: () => t('guide.description'),
            icon: GuideArtworkGit,
          },
        ],
      }),
    'dsh-git: 标签类型',
  )
  ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: GIT_ID,
        locale: NS,
        inject: (): ReposBodyInjected => ({
          // 时间取词走事件时间求值，跟随宿主当前语言
          formatTime: (timestampMs) =>
            new Date(timestampMs).toLocaleString(ctx.locale.getSnapshot().active, {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
        }),
      },
      ReposBody,
    ),
  )
}
