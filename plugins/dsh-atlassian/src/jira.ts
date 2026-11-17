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
  /** 扫描范围内被排除名单命中的评论条数（评论端点无服务端按作者过滤，过滤在扫描时进行）。 */
  commentsFiltered: number
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

  /** 机器人刷屏保护：扫描上限（超出即停并如实报告），防被排除评论占满近期历史时无限翻页。 */
  const COMMENT_SCAN_MAX = 200

  /**
   * 评论端点没有按作者过滤的服务端参数，且默认最旧在前：
   * orderBy=-created 让最新在前，从最新往回逐页扫描，排除名单命中不计数，
   * 攒满请求数或触及扫描上限即停——热工单与机器人刷屏都不把调用拖垮。
   */
  async function fetchRecentComments(
    encoded: string,
    options: { wanted: number; excludeAuthors: string[] },
    signal?: AbortSignal,
  ): Promise<{ comments: JiraComment[]; truncated: boolean; filtered: number }> {
    if (options.wanted <= 0) return { comments: [], truncated: false, filtered: 0 }
    const excluded = options.excludeAuthors.map((entry) => entry.toLowerCase())
    const pageSize = options.wanted + 10
    const comments: JiraComment[] = []
    let filtered = 0
    let scanned = 0
    let total: number | null = null
    for (let startAt = 0; comments.length < options.wanted; startAt += pageSize) {
      if (total !== null && scanned >= Math.min(total, COMMENT_SCAN_MAX)) break
      const payload = (await rest.get(
        `${apiPrefix}/issue/${encoded}/comment?maxResults=${pageSize}&startAt=${startAt}&orderBy=-created`,
        signal,
      )) as { comments?: unknown; total?: unknown } | null
      if (typeof payload?.total === 'number') total = payload.total
      const list = Array.isArray(payload?.comments) ? (payload.comments as RawComment[]) : []
      if (list.length === 0) break
      for (const comment of list) {
        scanned += 1
        if (comments.length >= options.wanted) break
        const author = optionalText(comment.author?.displayName) ?? ''
        if (excluded.some((entry) => author.toLowerCase().includes(entry))) {
          filtered += 1
          continue
        }
        comments.push({
          author,
          created: optionalText(comment.created),
          body: bodyToMarkdown(site.kind, comment.body),
        })
      }
      // 不足一页即到末尾；同时防服务端对越界 startAt 夹取导致停在同一页。
      if (list.length < pageSize) break
    }
    return { comments, truncated: total !== null && scanned < total, filtered }
  }

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
      options: { comments: number; maxDescriptionChars: number; excludeAuthors?: string[] },
      signal?: AbortSignal,
    ): Promise<JiraIssueDetail> {
      const encoded = encodeURIComponent(key)
      // fields 参数会让 Jira 裁剪返回体，详情必须显式带上 description。
      const payload = await rest.get(`${apiPrefix}/issue/${encoded}?fields=${FIELDS},description`, signal)
      const fields = ((payload as { fields?: unknown } | null)?.fields ?? {}) as RawFields
      const description = truncateText(
        bodyToMarkdown(site.kind, fields.description),
        options.maxDescriptionChars,
      )
      const recent = await fetchRecentComments(
        encoded,
        { wanted: options.comments, excludeAuthors: options.excludeAuthors ?? [] },
        signal,
      )
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
        comments: recent.comments,
        commentsTruncated: recent.truncated,
        commentsFiltered: recent.filtered,
      }
    },
    /** 连接测试：轻量身份端点，两代 API 同名。 */
    async myself(signal?: AbortSignal): Promise<void> {
      await rest.get(`${apiPrefix}/myself`, signal)
    },
  }
}

export type JiraClient = ReturnType<typeof createJiraClient>
