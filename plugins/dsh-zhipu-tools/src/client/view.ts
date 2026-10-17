import { KEY_REFS, type EndpointStatusView } from '../shared'
import type { ZhipuT } from './locales'

/** 端点面板的展示投影：纯函数，供面板渲染与单测共用；文案经 t 取词，Host 原因原样透传。 */
export interface EndpointDisplay {
  /** 填入内置设置的完整地址（null = 端点未监听）。 */
  urlText: string | null
  /** 填进内置密钥栏的 API 密钥（null = 端点未在监听）。 */
  tokenText: string | null
  listenText: string
  credentialText: string
  /** 凭据解析故障原文（无故障为 null）。 */
  credentialHint: string | null
  mcpText: string
}

export function projectEndpoint(t: ZhipuT, view: EndpointStatusView): EndpointDisplay {
  return {
    urlText: view.baseUrl,
    tokenText: view.token,
    listenText: view.baseUrl === null ? t('status.down') : t('status.listening', { port: String(view.port) }),
    credentialText: view.credential.configured
      ? t('credential.ok')
      : t('credential.missing', { refs: KEY_REFS.join(' / ') }),
    // failure 是 Host 给出的解析故障原文（errMsg），不翻译。
    credentialHint: view.credential.failure ?? null,
    mcpText: view.mcp.map((item) => `${item.server} ${item.mounted ? '✓' : '✗'}`).join('　'),
  }
}
