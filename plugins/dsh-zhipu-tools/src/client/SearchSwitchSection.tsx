import { useEffect, useSyncExternalStore } from 'react'
import { Switch, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsSectionOwnerProps } from '@deepseek-ai/dsh-client-ui-settings/client'
import { MetaItem, Panel } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import type { SearchSwitchStore } from './store'
import { projectSwitch } from './view'
import type { ZhipuT } from './locales'

/** 面板注入面（client/index.ts 装配，槽位 inject 回调提供）。 */
export interface SearchSwitchPanelEnv {
  store: SearchSwitchStore
  t: ZhipuT
}

export function SearchSwitchSection(props: SearchSwitchPanelEnv & SettingsSectionOwnerProps) {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (state.status === 'idle') void store.refresh()
  }, [store, state.status])
  useEffect(() => () => store.dismissNotice(), [store])

  const view = state.view
  const display = view === null ? null : projectSwitch(t, view, state.pending, state.busy)

  return (
    <Panel title={t('title')} subtitle={t('subtitle')}>
      {state.error ? (
        <div className={shared.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.notice !== null ? (
        <Toast key={state.notice} text={state.notice} holdMs={5000} onDone={() => store.dismissNotice()} />
      ) : null}
      {state.status === 'loading' ? <div className={shared.loading}>{t('loading')}</div> : null}
      {view === null || display === null ? null : (
        <>
          <div className={shared.checkRow}>
            <Switch
              checked={display.checked}
              disabled={display.disabled}
              label={t('switch.label')}
              title={display.switchTitle}
              onChange={(next) => void store.setEnabled(next)}
            />
            <span className={shared.label}>
              {display.waiting
                ? t('state.waiting')
                : display.checked
                  ? t('state.replaced')
                  : t('state.official')}
            </span>
          </div>
          <div className={shared.metaGrid}>
            <MetaItem label={t('meta.provider')} value={display.providerText} />
            <MetaItem label={t('meta.source')} value={display.sourceText} />
            <MetaItem label={t('meta.effect')} value={display.effectText} />
            <MetaItem
              label={t('meta.writeTarget')}
              value={
                view.writeTarget === 'create:home'
                  ? t('writeTarget.createHome', { path: view.patchPaths.home })
                  : view.writeTarget === 'in-place:home'
                    ? t('writeTarget.inPlaceHome', { path: view.patchPaths.home })
                    : t('writeTarget.inPlaceProfile', { path: view.patchPaths.profile })
              }
            />
          </div>
          {display.hint !== null ? <div className={shared.hint}>{display.hint}</div> : null}
        </>
      )}
    </Panel>
  )
}
