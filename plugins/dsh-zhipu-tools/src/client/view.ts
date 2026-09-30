import type { SearchSwitchView } from '../shared'
import type { ZhipuT } from './locales'

/** 开关的展示投影：纯函数，供面板渲染与单测共用；文案经 t 取词，Host 原因原样透传。 */
export interface SwitchDisplay {
  checked: boolean
  disabled: boolean
  switchTitle: string | undefined
  waiting: boolean
  providerText: string
  sourceText: string
  effectText: string
  hint: string | null
}

export function projectSwitch(
  t: ZhipuT,
  view: SearchSwitchView,
  pending: boolean | null,
  busy: boolean,
): SwitchDisplay {
  const checked = pending ?? view.active
  const waiting = pending !== null && view.active !== pending
  const disabled = busy || !view.editable
  const providerText = view.effectiveProvider ?? view.fileProvider ?? t('provider.unconfigured')
  const sourceText =
    view.effectiveProvider !== undefined
      ? view.effectiveProvider === view.fileProvider || view.fileProvider === null
        ? t('source.runtime')
        : t('source.runtimeUnequal', {
            provider: view.fileProvider ?? t('source.fileUnconfigured'),
          })
      : t('source.fileOnly')
  const effectText = waiting ? t('effect.waiting') : view.hotApply ? t('effect.hot') : t('effect.restart')
  // reason 是 Host 给出的不可编辑原因（errMsg 原文），不翻译。
  let hint: string | null = view.reason
  if (waiting) {
    hint = view.hotApply ? t('hint.settlingHot') : t('hint.settlingRestart')
  } else if (view.editable && view.active) {
    hint = t('hint.uninstall')
  }
  return {
    checked,
    disabled,
    switchTitle: view.editable ? undefined : (view.reason ?? t('hint.notEditable')),
    waiting,
    providerText,
    sourceText,
    effectText,
    hint,
  }
}
