import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createConfluenceClient } from './confluence'
import { createJiraClient } from './jira'
import type { SitesManager } from './sites'
import {
  confluenceProductOf,
  jiraProductOf,
  TOOL_CONF_GET_PAGE,
  TOOL_CONF_SEARCH,
  TOOL_JIRA_GET_ISSUE,
  TOOL_JIRA_SEARCH,
  type SiteDraft,
} from './shared'

export interface ToolDeps {
  /** hint 是调用内容（工单号 / JQL / CQL），供项目键自动匹配唯一站点。 */
  requireSite(name: string | undefined, hint?: string): SiteDraft
  /** Jira 凭据（cloud 兼作 Confluence）。 */
  jiraTokenOf(site: SiteDraft): Promise<string>
  /** Confluence 凭据（Server 独立 PAT；cloud 与 Jira 同一凭据）。 */
  confluenceTokenOf(site: SiteDraft): Promise<string>
}

const JIRA_SEARCH_LIMIT_MAX = 50
const CONF_SEARCH_LIMIT_MAX = 25
const DEFAULT_ISSUE_COMMENTS = 5
const COMMENT_BODY_CHARS = 800
const DEFAULT_DESCRIPTION_CHARS = 12_000
const DEFAULT_PAGE_CHARS = 12_000
const PAGE_CHARS_MIN = 2_000
const PAGE_CHARS_MAX = 50_000

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const clipLine = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text

// 工具产物进入宿主管道前须是 lossless JSON：可选字段经一次 JSON 往返剔除
// undefined；JSON.parse 的 any 恰好同时满足 schema 推断产物与 JsonValue。
const lossless = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value))

export function buildTools(deps: ToolDeps) {
  const jiraSearch = defineTool({
    name: TOOL_JIRA_SEARCH,
    description:
      '用 JQL 检索 Jira 工单，返回 key、标题、状态、负责人等摘要与浏览器链接。读取单个工单用 jira_get_issue。',
    parameters: {
      jql: {
        type: 'string',
        required: true,
        description: "JQL 查询，如 'assignee = currentUser() AND sprint in openSprints()'",
      },
      site: {
        type: 'string',
        description:
          '站点名（设置页中的站点名）；缺省时按 JQL 里的项目键自动匹配唯一站点，再落默认站点或唯一站点',
      },
      limit: { type: 'integer', description: `返回条数上限（1-${JIRA_SEARCH_LIMIT_MAX}，缺省 15）` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          site: { type: 'string', required: true },
          total: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          truncated: { type: 'boolean', required: true },
          issues: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string', required: true },
                summary: { type: 'string', required: true },
                url: { type: 'string', required: true },
                type: { type: 'string' },
                status: { type: 'string' },
                assignee: { type: 'string' },
                updated: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJiraSearch(value) }],
      presentationMeta: (_args, value) =>
        JSON.parse(
          JSON.stringify({
            kind: 'jira-search',
            site: value.site,
            total: value.total,
            truncated: value.truncated,
            issues: value.issues,
          }),
        ),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 35_000,
    async execute(args, exec) {
      const site = deps.requireSite(args.site, args.jql)
      const token = await deps.jiraTokenOf(site)
      const client = createJiraClient(jiraProductOf(site), token)
      const limit = clamp(args.limit ?? 15, 1, JIRA_SEARCH_LIMIT_MAX)
      return JSON.parse(JSON.stringify(await client.search(args.jql, limit, exec.signal)))
    },
  })

  const jiraGetIssue = defineTool({
    name: TOOL_JIRA_GET_ISSUE,
    description: '读取单个 Jira 工单：标题、状态、负责人、描述（markdown 化）与最近评论、浏览器链接。',
    parameters: {
      key: { type: 'string', required: true, description: '工单号，如 PROJ-123' },
      site: {
        type: 'string',
        description:
          '站点名；缺省时按工单号的项目键前缀（如 PROJ-123 的 PROJ）自动匹配唯一站点，再落默认站点或唯一站点',
      },
      comments: { type: 'integer', description: '附带最近评论的条数（0-20，缺省 5；0 = 不取评论）' },
      excludeAuthors: {
        type: 'array',
        items: { type: 'string' },
        description:
          '临时追加排除的评论作者（displayName 大小写不敏感子串匹配），与站点配置的评论过滤名单合并',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          site: { type: 'string', required: true },
          key: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          url: { type: 'string', required: true },
          labels: { type: 'array', required: true, items: { type: 'string' } },
          description: { type: 'string', required: true },
          descriptionTruncated: { type: 'boolean', required: true },
          descriptionTotalChars: { type: 'integer', required: true },
          comments: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                author: { type: 'string', required: true },
                body: { type: 'string', required: true },
                created: { type: 'string' },
              },
            },
          },
          commentsTruncated: { type: 'boolean', required: true },
          commentsFiltered: { type: 'integer', required: true },
          type: { type: 'string' },
          status: { type: 'string' },
          assignee: { type: 'string' },
          reporter: { type: 'string' },
          created: { type: 'string' },
          updated: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderJiraIssue(value) }],
      presentationMeta: (_args, value) =>
        JSON.parse(
          JSON.stringify({
            kind: 'jira-issue',
            key: value.key,
            summary: value.summary,
            status: value.status,
            type: value.type,
            assignee: value.assignee,
            url: value.url,
          }),
        ),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 35_000,
    async execute(args, exec) {
      const site = deps.requireSite(args.site, args.key)
      const token = await deps.jiraTokenOf(site)
      const client = createJiraClient(jiraProductOf(site), token)
      const comments = clamp(args.comments ?? DEFAULT_ISSUE_COMMENTS, 0, 20)
      // 站点配置的过滤名单是常设事实，调用参数临时追加：合并后交给 client 在扫描时过滤。
      const excludeAuthors = [...(site.commentExcludeAuthors ?? []), ...(args.excludeAuthors ?? [])]
      return JSON.parse(
        JSON.stringify(
          await client.issue(
            args.key.trim(),
            { comments, maxDescriptionChars: DEFAULT_DESCRIPTION_CHARS, excludeAuthors },
            exec.signal,
          ),
        ),
      )
    },
  })

  const confSearch = defineTool({
    name: TOOL_CONF_SEARCH,
    description:
      '用 CQL 检索 Confluence 文档（知识库搜索），返回标题、空间、摘要与页面 id；读取正文用 confluence_get_page。',
    parameters: {
      cql: {
        type: 'string',
        required: true,
        description:
          'Confluence CQL，如 \'type=page AND text ~ "部署流程"\'；自由关键词可写成 text ~ "关键词"',
      },
      site: {
        type: 'string',
        description: '站点名；缺省时按 CQL 里的空间键 / 项目键自动匹配唯一站点，再落默认站点或唯一站点',
      },
      limit: { type: 'integer', description: `返回条数上限（1-${CONF_SEARCH_LIMIT_MAX}，缺省 10）` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          site: { type: 'string', required: true },
          total: { oneOf: [{ type: 'number' }, { type: 'null' }], required: true },
          truncated: { type: 'boolean', required: true },
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                url: { type: 'string', required: true },
                space: { type: 'string' },
                type: { type: 'string' },
                excerpt: { type: 'string' },
                updated: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderConfSearch(value) }],
      presentationMeta: (_args, value) =>
        JSON.parse(
          JSON.stringify({
            kind: 'confluence-search',
            site: value.site,
            total: value.total,
            truncated: value.truncated,
            results: value.results,
          }),
        ),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 35_000,
    async execute(args, exec) {
      const site = deps.requireSite(args.site, args.cql)
      const token = await deps.confluenceTokenOf(site)
      const client = createConfluenceClient(confluenceProductOf(site), token)
      const limit = clamp(args.limit ?? 10, 1, CONF_SEARCH_LIMIT_MAX)
      return JSON.parse(JSON.stringify(await client.search(args.cql, limit, exec.signal)))
    },
  })

  const confGetPage = defineTool({
    name: TOOL_CONF_GET_PAGE,
    description:
      '读取一篇 Confluence 页面正文（markdown 化，超长自动截断并支持 offset 续取）。页面 id 来自 confluence_search。',
    parameters: {
      id: { type: 'string', required: true, description: '页面 id（confluence_search 结果里的 id）' },
      site: { type: 'string', description: '站点名；缺省用唯一站点或默认站点' },
      maxChars: {
        type: 'integer',
        description: `本次读取的字符数（${PAGE_CHARS_MIN}-${PAGE_CHARS_MAX}，缺省 ${DEFAULT_PAGE_CHARS}）`,
      },
      offset: { type: 'integer', description: '起始字符偏移（续取时传上次返回的 offset + body 长度）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          site: { type: 'string', required: true },
          id: { type: 'string', required: true },
          title: { type: 'string', required: true },
          url: { type: 'string', required: true },
          body: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          totalChars: { type: 'integer', required: true },
          space: { type: 'string' },
          version: { type: 'integer' },
          updated: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderConfPage(value) }],
      presentationMeta: (_args, value) =>
        JSON.parse(
          JSON.stringify({
            kind: 'confluence-page',
            id: value.id,
            title: value.title,
            space: value.space,
            url: value.url,
          }),
        ),
    },
    isConcurrencySafe: () => true,
    timeoutMs: 35_000,
    async execute(args, exec) {
      const site = deps.requireSite(args.site)
      const token = await deps.confluenceTokenOf(site)
      const client = createConfluenceClient(confluenceProductOf(site), token)
      const maxChars = clamp(args.maxChars ?? DEFAULT_PAGE_CHARS, PAGE_CHARS_MIN, PAGE_CHARS_MAX)
      return JSON.parse(
        JSON.stringify(
          await client.page(args.id.trim(), { maxChars, offset: Math.max(0, args.offset ?? 0) }, exec.signal),
        ),
      )
    },
  })

  return [jiraSearch, jiraGetIssue, confSearch, confGetPage]
}

// —— 产物消费视图：字段与上方 schema 一致（推断值结构对齐 client 的返回类型）——

interface JiraSearchValue {
  site: string
  total: number | null
  truncated: boolean
  issues: {
    key: string
    summary: string
    url: string
    type?: string
    status?: string
    assignee?: string
    updated?: string
  }[]
}

interface JiraIssueValue {
  site: string
  key: string
  summary: string
  url: string
  labels: string[]
  description: string
  descriptionTruncated: boolean
  descriptionTotalChars: number
  comments: { author: string; body: string; created?: string }[]
  commentsTruncated: boolean
  commentsFiltered: number
  type?: string
  status?: string
  assignee?: string
  reporter?: string
  created?: string
  updated?: string
}

interface ConfSearchValue {
  site: string
  total: number | null
  truncated: boolean
  results: {
    id: string
    title: string
    url: string
    space?: string
    type?: string
    excerpt?: string
    updated?: string
  }[]
}

interface ConfPageValue {
  site: string
  id: string
  title: string
  url: string
  body: string
  offset: number
  truncated: boolean
  totalChars: number
  space?: string
  version?: number
  updated?: string
}

function renderJiraSearch(value: JiraSearchValue): string {
  const head = `站点 ${value.site}：${value.total === null ? '总数未知' : `共 ${value.total} 条`}，返回 ${value.issues.length} 条`
  const lines = value.issues.map((issue) => {
    const extras = [
      issue.type,
      issue.status,
      issue.assignee === undefined ? undefined : `负责人: ${issue.assignee}`,
    ]
      .filter((item): item is string => item !== undefined)
      .join(' · ')
    return `\n- [${issue.key}] ${issue.summary}${extras === '' ? '' : `（${extras}）`}\n  ${issue.url}`
  })
  const tail = value.truncated ? '\n\n结果未完全返回：可收窄 JQL 或增大 limit 后重查。' : ''
  return [head, ...lines].join('') + tail
}

function renderJiraIssue(value: JiraIssueValue): string {
  const facts = [
    value.type === undefined ? undefined : `类型: ${value.type}`,
    value.status === undefined ? undefined : `状态: ${value.status}`,
    value.assignee === undefined ? undefined : `负责人: ${value.assignee}`,
    value.reporter === undefined ? undefined : `报告人: ${value.reporter}`,
    `标签: ${value.labels.length > 0 ? value.labels.join(', ') : '-'}`,
  ].filter((item): item is string => item !== undefined)
  const sections = [
    `${value.key} ${value.summary}`,
    facts.join(' · '),
    `创建: ${value.created ?? '-'} · 更新: ${value.updated ?? '-'} · 链接: ${value.url}`,
    '## 描述',
    value.description === '' ? '（无描述）' : value.description,
  ]
  if (value.descriptionTruncated) {
    sections.push(`（描述共 ${value.descriptionTotalChars} 字符，已截断）`)
  }
  if (value.comments.length > 0) {
    sections.push(
      `## 最近评论（${value.comments.length} 条）`,
      ...value.comments.map((comment) => {
        const meta = comment.author || '-'
        const when = comment.created === undefined ? '' : ` · ${comment.created}`
        return `- ${meta}${when}：${clipLine(comment.body, COMMENT_BODY_CHARS)}`
      }),
    )
  }
  if (value.commentsTruncated) {
    sections.push('（评论未全部返回，仅显示最近的若干条）')
  }
  if (value.commentsFiltered > 0) {
    sections.push(`（已按过滤名单排除 ${value.commentsFiltered} 条评论）`)
  }
  return sections.join('\n\n')
}

function renderConfSearch(value: ConfSearchValue): string {
  const head = `站点 ${value.site}：${value.total === null ? '' : `共 ${value.total} 条，`}返回 ${value.results.length} 条（读取正文用 confluence_get_page，参数传 id）`
  const lines = value.results.map((item) => {
    const extras = [item.space, item.type, item.updated === undefined ? undefined : `更新: ${item.updated}`]
      .filter((entry): entry is string => entry !== undefined)
      .join(' · ')
    const excerpt = item.excerpt === undefined ? '' : `\n  摘要: ${clipLine(item.excerpt, 200)}`
    return `\n- ${item.title}${extras === '' ? '' : `（${extras}）`} id=${item.id}\n  ${item.url}${excerpt}`
  })
  const tail = value.truncated ? '\n\n结果未完全返回：可收窄 CQL 或增大 limit 后重查。' : ''
  return [head, ...lines].join('') + tail
}

function renderConfPage(value: ConfPageValue): string {
  const head = `${value.title}（${value.space ?? '-'} · 版本 ${value.version ?? '-'} · 更新 ${value.updated ?? '-'}）\n链接: ${value.url}`
  const body = value.body === '' ? '（正文为空）' : value.body
  const tail = value.truncated
    ? `\n\n（正文共 ${value.totalChars} 字符，本次从 offset ${value.offset} 起；续取请传 offset=${value.offset + value.body.length}）`
    : ''
  return `${head}\n\n${body}${tail}`
}
