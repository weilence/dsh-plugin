import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { NS, type AtlassianT } from './locales'
import styles from './tool-cards.module.css'

// 卡片零固定文案：标题与列表全部来自工具产物（presentationMeta 持久化在
// tool/result 上，历史回放同样可用）；失败态只以红点与错误原文表达。

interface JiraIssueMeta {
  kind: 'jira-issue'
  key: string
  summary: string
  status?: string
  type?: string
  assignee?: string
  url: string
}

interface JiraSearchMeta {
  kind: 'jira-search'
  total: number | null
  truncated: boolean
  issues: { key: string; summary: string; status?: string; assignee?: string; type?: string; url: string }[]
}

interface ConfSearchMeta {
  kind: 'confluence-search'
  total: number | null
  truncated: boolean
  results: { id: string; title: string; space?: string; type?: string; updated?: string; url: string }[]
}

interface ConfPageMeta {
  kind: 'confluence-page'
  id: string
  title: string
  space?: string
  url: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

function metaOfKind(meta: unknown, kind: string): Record<string, unknown> | null {
  return isRecord(meta) && meta['kind'] === kind ? meta : null
}

const optional = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

function asIssueMeta(meta: unknown): JiraIssueMeta | null {
  const record = metaOfKind(meta, 'jira-issue')
  if (record === null || typeof record['key'] !== 'string' || typeof record['url'] !== 'string') return null
  return {
    kind: 'jira-issue',
    key: record['key'],
    summary: optional(record, 'summary') ?? '',
    status: optional(record, 'status'),
    type: optional(record, 'type'),
    assignee: optional(record, 'assignee'),
    url: record['url'],
  }
}

function asJiraSearchMeta(meta: unknown): JiraSearchMeta | null {
  const record = metaOfKind(meta, 'jira-search')
  if (record === null || !Array.isArray(record['issues'])) return null
  return {
    kind: 'jira-search',
    total: typeof record['total'] === 'number' ? record.total : null,
    truncated: record['truncated'] === true,
    issues: record['issues'].filter(isRecord).map((item) => ({
      key: typeof item['key'] === 'string' ? item['key'] : '',
      summary: optional(item, 'summary') ?? '',
      status: optional(item, 'status'),
      assignee: optional(item, 'assignee'),
      type: optional(item, 'type'),
      url: typeof item['url'] === 'string' ? item['url'] : '',
    })),
  }
}

function asConfSearchMeta(meta: unknown): ConfSearchMeta | null {
  const record = metaOfKind(meta, 'confluence-search')
  if (record === null || !Array.isArray(record['results'])) return null
  return {
    kind: 'confluence-search',
    total: typeof record['total'] === 'number' ? record.total : null,
    truncated: record['truncated'] === true,
    results: record['results'].filter(isRecord).map((item) => ({
      id: typeof item['id'] === 'string' ? item['id'] : '',
      title: optional(item, 'title') ?? '',
      space: optional(item, 'space'),
      type: optional(item, 'type'),
      updated: optional(item, 'updated'),
      url: typeof item['url'] === 'string' ? item['url'] : '',
    })),
  }
}

function asPageMeta(meta: unknown): ConfPageMeta | null {
  const record = metaOfKind(meta, 'confluence-page')
  if (record === null || typeof record['url'] !== 'string') return null
  return {
    kind: 'confluence-page',
    id: typeof record['id'] === 'string' ? record['id'] : '',
    title: optional(record, 'title') ?? '',
    space: optional(record, 'space'),
    url: record['url'],
  }
}

/** 工具面向模型的渲染文本（截断说明也在其中），展开区原样展示。 */
function textOf(block: { content: readonly unknown[] }): string {
  return block.content
    .map((entry) =>
      isRecord(entry) && entry['type'] === 'text' && typeof entry['text'] === 'string' ? entry['text'] : '',
    )
    .filter((text) => text !== '')
    .join('\n')
}

/** 从调用参数里挑一个可读的标题候选（key / id / 查询语句…）。 */
function argsTitle(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed)) {
      for (const key of ['key', 'id', 'title', 'jql', 'cql']) {
        const value = parsed[key]
        if (typeof value === 'string' && value !== '') return clip(value)
      }
    }
  } catch {
    // 参数尚未完整（preparing）或非 JSON：维持空标题。
  }
  return ''
}

const clip = (text: string, max = 80): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** 检索卡预览行：产品名 + 命中条数（total 未知时只报返回数），截断态追加标记。 */
function searchTitle(
  t: AtlassianT,
  product: 'jira' | 'conf',
  total: number | null,
  truncated: boolean,
  shown: number,
): string {
  const label =
    total !== null
      ? t(`tool.${product}.hits`, { count: total })
      : t(`tool.${product}.shown`, { count: shown })
  return truncated ? `${label} · ${t('tool.search.truncated')}` : label
}

type SearchCardProps = ToolCallViewProps & PropsLocale<typeof NS>

function callRaw(props: ToolCallViewProps): string {
  if (props.phase === 'start') return props.block.argsRaw
  if (props.phase === 'result') return props.block.call?.argsRaw ?? ''
  return ''
}

function PendingRow(props: { toolCallViewProps: ToolCallViewProps }): ReactNode {
  const title = argsTitle(callRaw(props.toolCallViewProps))
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <span className={styles.titlePending}>{title === '' ? '…' : title}</span>
      </div>
    </div>
  )
}

function LinkLabel(props: { url: string }): ReactNode {
  let host = props.url
  try {
    host = new URL(props.url).host
  } catch {
    // 非 http(s) 原样展示。
  }
  return (
    <a className={styles.link} href={props.url} target="_blank" rel="noreferrer" title={props.url}>
      {host}
    </a>
  )
}

function SettledCard(props: {
  toolCallViewProps: ToolCallViewProps
  title: ReactNode
  link: string | undefined
  status?: string
  failed: boolean
}): ReactNode {
  const { toolCallViewProps, title, link, status, failed } = props
  const disclosure = toolCallViewProps.useDisclosure()
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <button
          type="button"
          className={styles.rowMain}
          onClick={disclosure.toggle}
          aria-expanded={disclosure.expanded}
        >
          <span className={failed ? styles.titleFail : styles.title}>{title}</span>
          {status !== undefined ? <span className={styles.statusPill}>{status}</span> : null}
          {failed ? <span className={styles.errDot} aria-hidden /> : null}
        </button>
        {link !== undefined ? <LinkLabel url={link} /> : null}
      </div>
      {disclosure.expanded ? <pre className={styles.body}>{textOf(toolCallViewProps.block)}</pre> : null}
    </div>
  )
}

export function JiraIssueCard(props: ToolCallViewProps): ReactNode {
  if (props.phase !== 'result') return <PendingRow toolCallViewProps={props} />
  const meta = asIssueMeta(props.block.meta)
  return (
    <SettledCard
      toolCallViewProps={props}
      title={meta === null ? argsTitle(callRaw(props)) || 'jira_get_issue' : `${meta.key} · ${meta.summary}`}
      link={meta?.url}
      status={meta?.status}
      failed={props.block.isError || meta === null}
    />
  )
}

export function ConfPageCard(props: ToolCallViewProps): ReactNode {
  if (props.phase !== 'result') return <PendingRow toolCallViewProps={props} />
  const meta = asPageMeta(props.block.meta)
  return (
    <SettledCard
      toolCallViewProps={props}
      title={
        meta === null
          ? argsTitle(callRaw(props)) || 'confluence_get_page'
          : clip(meta.title || meta.id, 60) + (meta.space === undefined ? '' : ` · ${meta.space}`)
      }
      link={meta?.url}
      failed={props.block.isError || meta === null}
    />
  )
}

export function JiraSearchCard(props: SearchCardProps): ReactNode {
  if (props.phase !== 'result') return <PendingRow toolCallViewProps={props} />
  const meta = asJiraSearchMeta(props.block.meta)
  const disclosure = props.useDisclosure()
  const { t } = props
  return (
    <div className={styles.card}>
      {meta !== null && !props.block.isError ? (
        <button
          type="button"
          className={styles.rowMain}
          style={{ padding: '4px 8px' }}
          onClick={disclosure.toggle}
          aria-expanded={disclosure.expanded}
        >
          <span className={styles.title}>
            {searchTitle(t, 'jira', meta.total, meta.truncated, meta.issues.length)}
          </span>
        </button>
      ) : (
        <div className={styles.row}>
          <span className={props.block.isError ? styles.titleFail : styles.titlePending}>
            {argsTitle(callRaw(props)) || 'jira_search'}
          </span>
          {props.block.isError ? <span className={styles.errDot} aria-hidden /> : null}
        </div>
      )}
      {disclosure.expanded ? <pre className={styles.body}>{textOf(props.block)}</pre> : null}
    </div>
  )
}

export function ConfSearchCard(props: SearchCardProps): ReactNode {
  if (props.phase !== 'result') return <PendingRow toolCallViewProps={props} />
  const meta = asConfSearchMeta(props.block.meta)
  const disclosure = props.useDisclosure()
  const { t } = props
  return (
    <div className={styles.card}>
      {meta !== null && !props.block.isError ? (
        <button
          type="button"
          className={styles.rowMain}
          style={{ padding: '4px 8px' }}
          onClick={disclosure.toggle}
          aria-expanded={disclosure.expanded}
        >
          <span className={styles.title}>
            {searchTitle(t, 'conf', meta.total, meta.truncated, meta.results.length)}
          </span>
        </button>
      ) : (
        <div className={styles.row}>
          <span className={props.block.isError ? styles.titleFail : styles.titlePending}>
            {argsTitle(callRaw(props)) || 'confluence_search'}
          </span>
          {props.block.isError ? <span className={styles.errDot} aria-hidden /> : null}
        </div>
      )}
      {disclosure.expanded ? <pre className={styles.body}>{textOf(props.block)}</pre> : null}
    </div>
  )
}
