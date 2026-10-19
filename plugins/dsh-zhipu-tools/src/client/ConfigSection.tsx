import { useEffect, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Panel } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import type { ConfigStore } from './store'
import { projectConfig } from './view'
import type { NS } from './locales'

/** 注册方注入面（client/index.ts 装配，slot inject 回调提供）。 */
export interface ConfigSectionInjected {
  store: ConfigStore
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type ConfigSectionProps = PropsRuntime<'plugins.bundle.config'> &
  PropsLocale<typeof NS> &
  InjectFace<ConfigSectionInjected>

export function ConfigSection(props: ConfigSectionProps) {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (state.status === 'idle') void store.refresh()
  }, [store, state.status])
  useEffect(() => () => store.dismissNotice(), [store])

  const view = state.view
  const display = view === null ? null : projectConfig(t, view)

  return (
    <Panel>
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
          <div className={shared.fieldWide}>
            <span className={shared.label}>{t('credential.label')}</span>
            {/* 值行保持可选中复制（缺席提示里的引用名可能被引用）。 */}
            <p className={shared.hintLine}>{display.credentialText}</p>
          </div>
          <div className={shared.toolbar}>
            {/* 写入的前置条件是智谱凭据在场；缺失原因已在上方凭据行展示。 */}
            <Button disabled={!view.credential.configured} onClick={() => void store.apply()}>
              {t('apply.label')}
            </Button>
          </div>
          {/* apply 失败原文渲染在动作按钮旁，不随 Toast 消失。 */}
          {state.applyError !== null ? (
            <div className={shared.error} role="alert">
              {state.applyError}
            </div>
          ) : null}
          {display.credentialHint !== null ? (
            <div className={shared.error} role="alert">
              {display.credentialHint}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  )
}
