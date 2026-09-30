import { useEffect, useSyncExternalStore } from 'react'
import { Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { MetaItem, Panel } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import type { SearchSwitchStore } from './store'
import { projectSwitch } from './view'

/** 面板注入面（client/index.ts 装配，槽位 inject 回调提供）。 */
export interface SearchSwitchPanelEnv {
  store: SearchSwitchStore
}

export function SearchSwitchSection(props: SearchSwitchPanelEnv & SettingsSectionOwnerProps) {
  const store = props.store
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (state.status === 'idle') void store.refresh()
  }, [store, state.status])
  useEffect(() => () => store.dismissNotice(), [store])

  const view = state.view
  const display = view === null ? null : projectSwitch(view, state.pending, state.busy)

  return (
    <Panel
      title="智谱搜索"
      subtitle="把官方 web_search 工具的实际搜索后端切换为智谱联网搜索；工具名、参数与结果卡片保持官方原样。智谱搜索 / 网页阅读 MCP 工具不受此开关影响。"
    >
      {state.error ? (
        <div className={shared.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast key={state.notice} text={state.notice} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      {state.status === 'loading' ? <div className={shared.loading}>正在读取搜索替换状态…</div> : null}
      {view === null || display === null ? null : (
        <>
          <div className={shared.checkRow}>
            <Switch
              checked={display.checked}
              disabled={display.disabled}
              label="用智谱替换 web_search 搜索"
              title={display.switchTitle}
              onChange={(next) => void store.setEnabled(next)}
            />
            <span className={shared.label}>
              {display.waiting ? '等待生效' : display.checked ? '已替换' : '使用官方搜索'}
            </span>
          </div>
          <div className={shared.metaGrid}>
            <MetaItem label="当前生效搜索提供者" value={display.providerText} />
            <MetaItem label="状态来源" value={display.sourceText} />
            <MetaItem label="生效方式" value={display.effectText} />
            <MetaItem
              label="下次开启写入位置"
              value={
                view.writeTarget === 'create:home'
                  ? `新建于 ${view.patchPaths.home}`
                  : view.writeTarget === 'in-place:home'
                    ? `就地修改 ${view.patchPaths.home}`
                    : `就地修改 ${view.patchPaths.profile}`
              }
            />
          </div>
          {display.hint !== null ? <div className={shared.hint}>{display.hint}</div> : null}
        </>
      )}
    </Panel>
  )
}
