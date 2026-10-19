import { KEY_REFS, type StatusView } from '../shared'
import type { ZhipuT } from './locales'

/** 接入面板的展示投影：纯函数，供面板渲染与单测共用；文案经 t 取词，Host 原因原样透传。 */
export interface ConfigDisplay {
  /** 凭据徽标：仅凭据不可用时出现（正常一律不出声）；解析故障也按未配置展示，原文走错误行。 */
  credentialBadge: { text: string; tone: 'warn' } | null
  /** 徽标悬停说明：缺席时的引用名或解析故障原文（无可悬停为 null）。 */
  credentialTitle: string | null
  /** 凭据解析故障原文（渲染为错误行；无故障为 null）。 */
  failureText: string | null
}

export function projectConfig(t: ZhipuT, view: StatusView): ConfigDisplay {
  if (view.credential.configured) {
    return { credentialBadge: null, credentialTitle: null, failureText: null }
  }
  return {
    credentialBadge: { text: t('credential.badge.missing'), tone: 'warn' },
    // 徽标悬停说明：缺席给引用名，故障给原文（errMsg），都不翻译。
    credentialTitle: view.credential.failure ?? t('credential.missing', { refs: KEY_REFS.join(' / ') }),
    failureText: view.credential.failure ?? null,
  }
}
