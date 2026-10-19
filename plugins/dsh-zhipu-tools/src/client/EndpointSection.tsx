import { useEffect, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Panel } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import type { EndpointStore } from './store'
import { projectEndpoint } from './view'
import type { NS } from './locales'

/** 注册方注入面（client/index.ts 装配，slot inject 回调提供）。 */
export interface EndpointSectionInjected {
  store: EndpointStore
}

/** 完整组件 props：运行时份额 + locale 标准 seat + 注入面。 */
export type EndpointSectionProps = PropsRuntime<'plugins.bundle.config'> &
  PropsLocale<typeof NS> &
  InjectFace<EndpointSectionInjected>

export function EndpointSection(props: EndpointSectionProps) {
  const { store, t } = props
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    if (state.status === 'idle') void store.refresh()
  }, [store, state.status])
  useEffect(() => () => store.dismissNotice(), [store])

  const view = state.view
  const display = view === null ? null : projectEndpoint(t, view)
  // 写入的前置条件：端点在监听且智谱凭据在场；原因经状态行展示。
  const applyReady = view !== null && view.baseUrl !== null && view.credential.configured

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
            <span className={shared.label}>{t('endpoint.label')}</span>
            <div className={shared.toolbar}>
              {/* 端点地址是内置设置要填的值：code 字体行保持可选中。 */}
              <p className={shared.hintLine}>{display.urlText}</p>
            </div>
          </div>
          <div className={shared.toolbar}>
            <Button disabled={!applyReady} onClick={() => void store.apply()}>
              {t('apply.label')}
            </Button>
          </div>
          {/* apply 失败原文渲染在动作按钮旁，不随 Toast 消失。 */}
          {state.applyError !== null ? (
            <div className={shared.error} role="alert">
              {state.applyError}
            </div>
          ) : null}
          {display.statusText !== null ? <p className={shared.hint}>{display.statusText}</p> : null}
          {/* failure 是 Host 给出的端点启动失败原文（errMsg），不翻译。 */}
          {view.failure !== null ? (
            <div className={shared.error} role="alert">
              {view.failure}
            </div>
          ) : null}
          {display.credentialHint !== null ? <p className={shared.hint}>{display.credentialHint}</p> : null}
        </>
      )}
    </Panel>
  )
}
