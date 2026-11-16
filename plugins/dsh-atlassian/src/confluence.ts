import { storageToMarkdown, truncateText } from './markup'
import { createRestClient, type FetchLike } from './rest'
import type { ProductSite } from './shared'

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

export interface ConfSearchItem {
  id: string
  title: string
  space?: string
  type?: string
  excerpt?: string
  updated?: string
  url: string
}

export interface ConfSearchResult {
  site: string
  total: number | null
  results: ConfSearchItem[]
  truncated: boolean
}

export interface ConfPage {
  site: string
  id: string
  title: string
  space?: string
  version?: number
  updated?: string
  url: string
  body: string
  offset: number
  truncated: boolean
  totalChars: number
}

/** Confluence REST client：cloud 带 /wiki 前缀、server 不带，其余同为 v1 形状。 */
export function createConfluenceClient(site: ProductSite, token: string, fetchImpl?: FetchLike) {
  const rest = createRestClient(site, token, fetchImpl)
  const prefix = site.kind === 'cloud' ? '/wiki/rest/api' : '/rest/api'
  const baseUrl = site.url.replace(/\/+$/, '')

  function pageUrl(id: string, spaceKey?: string): string {
    if (site.kind === 'cloud') {
      return spaceKey !== undefined
        ? `${baseUrl}/wiki/spaces/${encodeURIComponent(spaceKey)}/pages/${id}`
        : `${baseUrl}/wiki/pages/viewpage.action?pageId=${id}`
    }
    return `${baseUrl}/pages/viewpage.action?pageId=${id}`
  }

  return {
    pageUrl,
    async search(cql: string, limit: number, signal?: AbortSignal): Promise<ConfSearchResult> {
      // CQL 搜索在 v1（/rest/api/search）；v2 至今没有等价检索面。
      const payload = (await rest.get(
        `${prefix}/search?cql=${encodeURIComponent(cql)}&limit=${limit}`,
        signal,
      )) as {
        results?: unknown
        totalSize?: unknown
        _links?: { next?: unknown }
      } | null
      const list = Array.isArray(payload?.results) ? (payload.results as Record<string, unknown>[]) : []
      const total = typeof payload?.totalSize === 'number' ? payload.totalSize : null
      const truncated = typeof payload?._links?.next === 'string' || (total !== null && list.length < total)
      return {
        site: site.name,
        total,
        truncated,
        results: list
          .map((item) => {
            const content = (item['content'] ?? {}) as Record<string, unknown>
            const space = (content['space'] ?? {}) as Record<string, unknown>
            const id = typeof content['id'] === 'string' ? content['id'] : String(content['id'] ?? '')
            const spaceKey = optionalText(space['key'])
            const rawUrl = optionalText(item['url'])
            return {
              id,
              title: optionalText(content['title']) ?? optionalText(item['title']) ?? '',
              space: optionalText(space['name']) ?? spaceKey,
              type: optionalText(content['type']),
              excerpt: optionalText(item['excerpt']),
              updated: optionalText(item['lastModified']),
              url:
                rawUrl !== undefined
                  ? rawUrl.startsWith('http')
                    ? rawUrl
                    : `${baseUrl}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
                  : pageUrl(id, spaceKey),
            }
          })
          .filter((item) => item.id !== ''),
      }
    },
    async page(
      id: string,
      options: { maxChars: number; offset: number },
      signal?: AbortSignal,
    ): Promise<ConfPage> {
      const payload = (await rest.get(
        `${prefix}/content/${encodeURIComponent(id)}?expand=body.storage,space,version`,
        signal,
      )) as Record<string, unknown> | null
      const body = (payload?.['body'] ?? {}) as Record<string, unknown>
      const storage = (body['storage'] ?? {}) as Record<string, unknown>
      const space = (payload?.['space'] ?? {}) as Record<string, unknown>
      const version = (payload?.['version'] ?? {}) as Record<string, unknown>
      const markdown = storageToMarkdown(typeof storage['value'] === 'string' ? storage['value'] : '')
      const truncated = truncateText(markdown, options.maxChars, options.offset)
      const pageId = optionalText(payload?.['id']) ?? id
      const spaceKey = optionalText(space['key'])
      return {
        site: site.name,
        id: pageId,
        title: optionalText(payload?.['title']) ?? '',
        space: optionalText(space['name']) ?? spaceKey,
        version: typeof version['number'] === 'number' ? version.number : undefined,
        updated: optionalText(version['when']),
        url: pageUrl(pageId, spaceKey),
        body: truncated.text,
        offset: truncated.offset,
        truncated: truncated.truncated,
        totalChars: truncated.totalChars,
      }
    },
    /** 连接测试：列一个空间即可，两代 API 同形。 */
    async spacesProbe(signal?: AbortSignal): Promise<void> {
      await rest.get(`${prefix}/space?limit=1`, signal)
    },
  }
}

export type ConfluenceClient = ReturnType<typeof createConfluenceClient>
