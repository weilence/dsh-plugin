import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only：settings.section 槽位契约、ctx.slots 的 Context 声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { RemoteSection, type RemotePanelEnv } from './client/RemoteSection'
import { RemoteStore } from './client/store'

export const inject: string[] = ['slots']

export function apply(ctx: ClientContext) {
  const store = new RemoteStore()
  const env: RemotePanelEnv = { store }

  ctx.slots.inject('settings.section', () => {
    return ctx.slots.register(
      {
        name: 'settings.section',
        id: 'dsh-remote',
        order: 42,
        label: () => '远程开发',
        inject: (): RemotePanelEnv => env,
      },
      RemoteSection,
    )
  })
}
