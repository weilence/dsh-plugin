import { useEffect, useSyncExternalStore } from 'react'
import { Button, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MetaItem, Panel } from '@dsh-plugins/client-ui'
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
          <div className={shared.fieldWide}>
            <span className={shared.label}>{t('endpoint.label')}</span>
            <div className={shared.toolbar}>
              {/* 端点地址是复制目标：code 字体行保持可选中，不被按钮遮挡换行。 */}
              <p className={shared.hintLine}>{display.urlText}</p>
              <Button disabled={display.urlText === null} onClick={() => void store.copyUrl()}>
                {t('endpoint.copy')}
              </Button>
            </div>
          </div>
          <div className={shared.fieldWide}>
            <span className={shared.label}>{t('endpoint.key')}</span>
            <div className={shared.toolbar}>
              {/* API 密钥同样是复制目标，与地址同款可选中行。 */}
              <p className={shared.hintLine}>{display.tokenText}</p>
              <Button disabled={display.tokenText === null} onClick={() => void store.copyToken()}>
                {t('endpoint.copyKey')}
              </Button>
            </div>
          </div>
          <div className={shared.metaGrid}>
            <MetaItem label={t('meta.listen')} value={display.listenText} />
            <MetaItem label={t('meta.credential')} value={display.credentialText} />
            <MetaItem label={t('meta.mcp')} value={display.mcpText} />
            <MetaItem label={t('meta.fetchBackend')} value="智谱 webReader" />
          </div>
          {/* failure 是 Host 给出的端点启动失败原文（errMsg），不翻译。 */}
          {view.failure !== null ? (
            <div className={shared.error} role="alert">
              {view.failure}
            </div>
          ) : null}
          {display.credentialHint !== null ? <p className={shared.hint}>{display.credentialHint}</p> : null}
          <div className={shared.section}>
            <h4 className={shared.sectionTitle}>{t('steps.title')}</h4>
            <ol className={shared.section}>
              <li>{t('step.open')}</li>
              <li>{t('step.enable')}</li>
              <li>{t('step.paste')}</li>
              <li>{t('step.key')}</li>
            </ol>
            <p className={shared.hint}>{t('note.deepseekKey')}</p>
            <p className={shared.hint}>{t('note.security')}</p>
            <p className={shared.hint}>{t('note.fetch')}</p>
          </div>
        </>
      )}
    </Panel>
  )
}
