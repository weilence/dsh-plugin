/**
 * 注册进 `ctx.web` 的两个 provider：智谱联网搜索与网页阅读直接成为可点名的后端。
 * 核心已返回 web 服务同构类型，本层只做接口适配，不做任何线协议转译。
 */
import type {
  WebFetchProvider,
  WebFetchRequest,
  WebFetchResult,
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
} from '@deepseek-ai/dsh-web'
import type { ZhipuReader } from './reader'
import type { ZhipuSearch } from './search'
import { FETCH_PROVIDER_ID, SEARCH_PROVIDER_ID } from './shared'

export class ZhipuSearchProvider implements WebSearchProvider {
  readonly id = SEARCH_PROVIDER_ID

  /** @param isAvailable - 凭据在场的同步快照（状态路由每次读取时刷新，此处不发网络）。 */
  constructor(
    private readonly searchCore: ZhipuSearch,
    private readonly isAvailable: () => boolean,
  ) {}

  available(): boolean {
    return this.isAvailable()
  }

  search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    // maxResults 由 web 服务统一截断：智谱侧无对应入参。
    return this.searchCore(request.query, signal)
  }
}

export class ZhipuFetchProvider implements WebFetchProvider {
  readonly id = FETCH_PROVIDER_ID

  /** @param isAvailable - 凭据在场的同步快照（状态路由每次读取时刷新，此处不发网络）。 */
  constructor(
    private readonly read: ZhipuReader,
    private readonly isAvailable: () => boolean,
  ) {}

  available(): boolean {
    return this.isAvailable()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    // webReader 不报告目标页状态码与最终 URL：成功即目标页取回（口径对齐官方 Fetch API provider）。
    const content = await this.read(request.url, signal)
    return { url: request.url, statusCode: 200, body: { kind: 'text', content }, truncated: false }
  }
}
