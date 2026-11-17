import { adfToMarkdown, truncateText, wikiToMarkdown } from './markup'
import { createRestClient, type FetchLike } from './rest'
import type { ProductSite, SiteKind } from './shared'

export interface JiraIssueSummary {
  key: string
  summary: string
  type?: string
  status?: string
  assignee?: string
  updated?: string
  url: string
}

export interface JiraSearchResult {
  site: string
  /** 新版 cloud 搜索不保证返回总数；null = 未知。 */
  total: number | null
  issues: JiraIssueSummary[]
  truncated: boolean
}

export interface JiraComment {
  author: string
  created?: string
  body: string
}

export interface JiraIssueDetail extends JiraIssueSummary {
  /** 产物经宿主管道按 output schema 强校验，四个 client 方法都必须携带站点名。 */
  site: string
  reporter?: string
  labels: string[]
  created?: string
  description: string
  descriptionTruncated: boolean
  descriptionTotalChars: number
  comments: JiraComment[]
  commentsTruncated: boolean
}

interface RawFields {
  summary?: unknown
  issuetype?: { name?: unknown }
  status?: { name?: unknown }
  assignee?: { displayName?: unknown }
  reporter?: { displayName?: unknown }
  labels?: unknown
  created?: unknown
  updated?: unknown
  description?: unknown
}

interface RawComment {
  author?: { displayName?: unknown }
  created?: unknown
  body?: unknown
}

const optionalText = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

function bodyToMarkdown(kind: SiteKind, body: unknown): string {
  if (kind === 'cloud') return adfToMarkdown(body)
  return typeof body === 'string' ? wikiToMarkdown(body) : ''
}

/** Jira REST client：cloud v3 与 server v2 的搜索/详情差异收在这一层。 */
export function createJiraClient(site: ProductSite, token: string, fetchImpl?: FetchLike) {
  const rest = createRestClient(site, token, fetchImpl)
  const apiPrefix = site.kind === 'cloud' ? '/rest/api/3' : '/rest/api/2'
  const baseUrl = site.url.replace(/\/+$/, '')
  const issueUrl = (key: string): string => `${baseUrl}/browse/${encodeURIComponent(key)}`

  const FIELDS = 'summary,issuetype,status,assignee,reporter,labels,created,updated'

  function parseSummary(key: string, fields: RawFields): JiraIssueSummary {
    return {
      key,
      summary: optionalText(fields.summary) ?? '',
      type: optionalText(fields.issuetype?.name),
      status: optionalText(fields.status?.name),
      assignee: optionalText(fields.assignee?.displayName),
      updated: optionalText(fields.updated),
      url: issueUrl(key),
    }
  }

  return {
    issueUrl,
    async search(jql: string, limit: number, signal?: AbortSignal): Promise<JiraSearchResult> {
      // cloud：旧 /rest/api/3/search 已整体移除，走新 /search/jql（POST，nextPageToken 分页）；
      // server：/rest/api/2/search 原样可用。
      const payload =
        site.kind === 'cloud'
          ? await rest.post(
              `${apiPrefix}/search/jql`,
              { jql, maxResults: limit, fields: FIELDS.split(',') },
              signal,
            )
          : await rest.get(
              `${apiPrefix}/search?jql=${encodeURIComponent(jql)}&maxResults=${limit}&fields=${FIELDS}`,
              signal,
            )
      const record = payload as { issues?: unknown; total?: unknown; nextPageToken?: unknown } | null
      const list = Array.isArray(record?.issues)
        ? (record.issues as { key?: unknown; fields?: RawFields }[])
        : []
      const total = typeof record?.total === 'number' ? record.total : null
      const truncated =
        total !== null
          ? list.length < total
          : typeof record?.nextPageToken === 'string' || typeof record?.nextPageToken === 'object'
      return {
        site: site.name,
        total,
        truncated,
        issues: list
          .filter((item) => typeof item.key === 'string')
          .map((item) => parseSummary(item.key as string, item.fields ?? {})),
      }
    },
    async issue(
      key: string,
      options: { comments: number; maxDescriptionChars: number },
      signal?: AbortSignal,
    ): Promise<JiraIssueDetail> {
      const encoded = encodeURIComponent(key)
      const payload = await rest.get(`${apiPrefix}/issue/${encoded}?fields=${FIELDS}`, signal)
      const fields = ((payload as { fields?: unknown } | null)?.fields ?? {}) as RawFields
      const description = truncateText(
        bodyToMarkdown(site.kind, fields.description),
        options.maxDescriptionChars,
      )
      let comments: JiraComment[] = []
      let commentsTruncated = false
      if (options.comments > 0) {
        // 只取一页再截尾部：海量评论的工单不被整页拖垮，最近评论优先。
        const commentPayload = (await rest.get(
          `${apiPrefix}/issue/${encoded}/comment?maxResults=${options.comments + 10}`,
          signal,
        )) as { comments?: unknown; total?: unknown } | null
        const list = Array.isArray(commentPayload?.comments) ? (commentPayload.comments as RawComment[]) : []
        comments = list.slice(-options.comments).map((comment) => ({
          author: optionalText(comment.author?.displayName) ?? '',
          created: optionalText(comment.created),
          body: bodyToMarkdown(site.kind, comment.body),
        }))
        const total = typeof commentPayload?.total === 'number' ? commentPayload.total : null
        commentsTruncated = total !== null && total > list.length
      }
      return {
        site: site.name,
        ...parseSummary(key, fields),
        reporter: optionalText(fields.reporter?.displayName),
        labels: Array.isArray(fields.labels)
          ? fields.labels.filter((item): item is string => typeof item === 'string')
          : [],
        created: optionalText(fields.created),
        description: description.text,
        descriptionTruncated: description.truncated,
        descriptionTotalChars: description.totalChars,
        comments,
        commentsTruncated,
      }
    },
    /** 连接测试：轻量身份端点，两代 API 同名。 */
    async myself(signal?: AbortSignal): Promise<void> {
      await rest.get(`${apiPrefix}/myself`, signal)
    },
  }
}

export type JiraClient = ReturnType<typeof createJiraClient>
