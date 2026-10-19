import { KEY_REFS, type StatusView } from '../shared'
import type { ZhipuT } from './locales'

/** 接入面板的展示投影：纯函数，供面板渲染与单测共用；文案经 t 取词，Host 原因原样透传。 */
export interface ConfigDisplay {
  /** 凭据状态单行（缺席时含候选引用名）。 */
  credentialText: string
  /** 凭据解析故障原文（无故障为 null）。 */
  credentialHint: string | null
}

export function projectConfig(t: ZhipuT, view: StatusView): ConfigDisplay {
  return {
    credentialText: view.credential.configured
      ? t('credential.ok')
      : t('credential.missing', { refs: KEY_REFS.join(' / ') }),
    // failure 是 Host 给出的解析故障原文（errMsg），不翻译。
    credentialHint: view.credential.failure ?? null,
  }
}
