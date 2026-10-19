import { useEffect, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Panel, Pill } from '@dsh-plugins/client-ui'
import shared from '@dsh-plugins/client-ui/styles'
import type { ConfigStore } from './store'
import { projectConfig } from './view'
import type { NS } from './locales'
import styles from './ConfigSection.module.css'

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

  const view = state.view
  const display = view === null ? null : projectConfig(t, view)

  return (
    <Panel>
      {state.error ? (
        <div className={shared.error} role="alert">
          {state.error}
        </div>
      ) : null}
      {state.status === 'loading' ? <div className={shared.loading}>{t('loading')}</div> : null}
      {view === null || display === null ? null : (
        <>
          {/* 行式布局对齐官方 Web search 卡片：左文案右开关，下随一行辅助说明。 */}
          <div className={styles.feature}>
            <div className={styles.toggleRow}>
              <label className={styles.toggleMain}>
                <span>{t('switch.label')}</span>
                {/* 开关受控于服务端状态：凭据缺失不禁用（关闭方向仍合法），
                    开启被拒的原文渲染在下方错误行。 */}
                <Switch
                  checked={view.enabled}
                  label={t('switch.label')}
                  disabled={state.pending}
                  onChange={(next) => void store.toggle(next)}
                />
              </label>
              {/* 凭据徽标仅在不可用时出现（正常不出声）；在 label 外，点击不切换开关。 */}
              {display.credentialBadge !== null ? (
                <Pill
                  text={display.credentialBadge.text}
                  tone={display.credentialBadge.tone}
                  title={display.credentialTitle ?? undefined}
                />
              ) : null}
            </div>
            <p className={shared.hint}>{t('switch.hint')}</p>
          </div>
          {/* toggle 失败原文渲染在开关旁，不随任何弹层消失。 */}
          {state.toggleError !== null ? (
            <div className={shared.error} role="alert">
              {state.toggleError}
            </div>
          ) : null}
          {display.failureText !== null ? (
            <div className={shared.error} role="alert">
              {display.failureText}
            </div>
          ) : null}
        </>
      )}
    </Panel>
  )
}
