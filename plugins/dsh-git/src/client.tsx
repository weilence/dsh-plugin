/** 右侧栏「Git 仓库」标签：注册标签类型、标签体与插件详情页配置面板。 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { locateRepo } from './client/api'
import { pushContextOpen } from './client/contextOpen'
import { ConfigSection } from './client/ConfigSection'
import { GuideArtworkGit } from './client/GuideArtworkGit'
import { ReposBody, type ReposBodyInjected } from './client/ReposBody'
import { en, NS, zh } from './client/locales'

/** 标签类型 kind；指南页入口按 kind 打开页面。 */
const GIT_KIND = 'git-repos'
/** 实现标识，同时是标签体在 keyed 槽位上的注册键。 */
const GIT_ID = '@weilence/dsh-git'

export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'contextMenus']

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
          formatRelative: (timestampMs) => {
            const diff = timestampMs - Date.now()
            const units: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
              ['year', 365 * 86_400_000],
              ['month', 30 * 86_400_000],
              ['week', 7 * 86_400_000],
              ['day', 86_400_000],
              ['hour', 3_600_000],
              ['minute', 60_000],
              ['second', 1_000],
            ]
            const formatter = new Intl.RelativeTimeFormat(ctx.locale.getSnapshot().active, {
              numeric: 'auto',
            })
            for (const [unit, span] of units) {
              if (Math.abs(diff) >= span) return formatter.format(Math.round(diff / span), unit)
            }
            return formatter.format(0, 'second')
          },
        }),
      },
      ReposBody,
    ),
  )
  // 插件详情页配置面板（keyed 包名）：设置 → 插件 → 点开「Git 仓库」即见，
  // 悬停弹出延时的编辑入口收敛在此，不再占提交图头部
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      {
        name: 'plugins.bundle.config',
        key: GIT_ID,
        locale: NS,
      },
      ConfigSection,
    ),
  )
  // 文件树目录右键菜单：目录本身或最近祖先是 Git 仓库时提供「查看提交历史」，
  // 定位走 host 的逐级判定（不递归扫描），命中后预选仓库并打开标签
  ctx.effect(
    () =>
      ctx.contextMenus.register({
        id: 'open-repo',
        target: 'directory',
        order: 45,
        resolve: async (target, signal) => {
          const cwd = ctx.sessions.list.getSnapshot().byId[target.sessionId]?.cwd
          if (cwd === undefined) return []
          const { repoRoot } = await locateRepo(cwd, target.path, signal)
          if (repoRoot === null) return []
          return [
            {
              id: 'open-repo',
              // 事件时间取词：菜单打开时按宿主当前语言求值
              label: t('context.openRepo'),
              run: () => {
                pushContextOpen(target.sessionId, repoRoot)
                ctx.sidebarRight.openTab(GIT_KIND)
              },
            },
          ]
        },
      }),
    'dsh-git: 目录右键菜单',
  )
}
