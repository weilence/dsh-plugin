import { KEY_REFS, type EndpointStatusView } from '../shared'
import type { ZhipuT } from './locales'

/** 端点面板的展示投影：纯函数，供面板渲染与单测共用；文案经 t 取词，Host 原因原样透传。 */
export interface EndpointDisplay {
  /** 填入内置设置的完整地址（null = 端点未监听）。 */
  urlText: string | null
  /** 异常时的单行状态（未监听或凭据未配置）；正常运行为 null，面板不出声。 */
  statusText: string | null
  /** 凭据解析故障原文（无故障为 null）。 */
  credentialHint: string | null
}

export function projectEndpoint(t: ZhipuT, view: EndpointStatusView): EndpointDisplay {
  const listening = view.baseUrl !== null
  const credential = view.credential.configured
    ? t('credential.ok')
    : t('credential.missing', { refs: KEY_REFS.join(' / ') })
  return {
    urlText: view.baseUrl,
    statusText:
      listening && view.credential.configured
        ? null
        : `${listening ? t('status.listening') : t('status.down')} · ${credential}`,
    // failure 是 Host 给出的解析故障原文（errMsg），不翻译。
    credentialHint: view.credential.failure ?? null,
  }
}
