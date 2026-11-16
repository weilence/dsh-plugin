import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'
import {
  PROJECT_KEY_PATTERN,
  ROW_ID,
  SITE_NAME_PATTERN,
  type CredentialStateView,
  type SiteDraft,
  type SiteKind,
  type SitesView,
  type SiteView,
} from './shared'

/** 引用名缺省派生：站点名转大写下划线，正好是环境变量形态。 */
function refName(name: string): string {
  return name.toUpperCase().replace(/-/g, '_')
}

/** Jira 凭据引用：cloud 用 Atlassian 共用引用，server 用显式 Jira 引用。 */
export function jiraTokenRefOf(site: SiteDraft): string {
  return site.kind === 'cloud'
    ? (site.atlassianTokenRef ?? `ATLASSIAN_${refName(site.name)}_TOKEN`)
    : (site.jiraTokenRef ?? `ATLASSIAN_${refName(site.name)}_JIRA_TOKEN`)
}

/** Confluence 凭据引用：cloud 与 Jira 共用同一份；server 用独立引用（独立 PAT）。 */
export function confluenceTokenRefOf(site: SiteDraft): string {
  return site.kind === 'cloud'
    ? jiraTokenRefOf(site)
    : (site.confluenceTokenRef ?? `ATLASSIAN_${refName(site.name)}_CONFLUENCE_TOKEN`)
}

/** URL 归一：http(s) 校验 + 去尾斜杠；field 用于错误消息。 */
function normalizeUrl(value: string, field: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new HttpError(400, `${field} 协议必须是 http 或 https`)
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '')
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, `${field} 不是合法的 URL`)
  }
}

/** 单条草稿校验：面板写入与 normalizeSites 共用一套失败语义。 */
export function validateSiteDraft(raw: unknown): SiteDraft {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new HttpError(400, '站点必须是对象')
  }
  const raw_ = raw as Record<string, unknown>
  const name = raw_['name']
  if (typeof name !== 'string' || !SITE_NAME_PATTERN.test(name)) {
    throw new HttpError(400, `站点名需匹配 ${SITE_NAME_PATTERN.source}，如 acme`)
  }
  const kind = raw_['kind']
  if (kind !== 'cloud' && kind !== 'server') throw new HttpError(400, 'kind 必须是 cloud 或 server')
  const site: Partial<SiteDraft> = { name, kind: kind as SiteKind }
  if (kind === 'cloud') {
    const atlassianUrl = raw_['atlassianUrl']
    if (typeof atlassianUrl !== 'string' || atlassianUrl === '') {
      throw new HttpError(400, 'cloud 站点需要 atlassianUrl（Jira 与 Confluence 同域）')
    }
    site.atlassianUrl = normalizeUrl(atlassianUrl, 'atlassianUrl')
    const email = raw_['email']
    if (typeof email !== 'string' || email === '') {
      throw new HttpError(400, 'cloud 站点需要 email（API token 所属账号）')
    }
    site.email = email
  } else {
    const jiraUrl = raw_['jiraUrl']
    if (typeof jiraUrl !== 'string' || jiraUrl === '') throw new HttpError(400, 'server 站点需要 jiraUrl')
    site.jiraUrl = normalizeUrl(jiraUrl, 'jiraUrl')
    const confluenceUrl = raw_['confluenceUrl']
    if (typeof confluenceUrl !== 'string' || confluenceUrl === '') {
      throw new HttpError(400, 'server 站点需要单独的 confluenceUrl（Jira 与 Confluence 分开部署）')
    }
    site.confluenceUrl = normalizeUrl(confluenceUrl, 'confluenceUrl')
    if (raw_['atlassianUrl'] !== undefined) {
      throw new HttpError(400, 'atlassianUrl 仅 cloud 站点使用（server 分别配置 jiraUrl 与 confluenceUrl）')
    }
  }
  if (kind === 'cloud') {
    for (const key of ['jiraUrl', 'confluenceUrl'] as const) {
      if (raw_[key] !== undefined) {
        throw new HttpError(400, `${key} 仅 server 站点使用（cloud 用 atlassianUrl）`)
      }
    }
  }
  const atlassianTokenRef = raw_['atlassianTokenRef']
  if (atlassianTokenRef !== undefined) {
    if (typeof atlassianTokenRef !== 'string' || atlassianTokenRef === '') {
      throw new HttpError(400, 'atlassianTokenRef 必须是非空字符串')
    }
    if (kind !== 'cloud') {
      throw new HttpError(400, 'atlassianTokenRef 仅 cloud 站点使用（server 分别配置两份凭据）')
    }
    site.atlassianTokenRef = atlassianTokenRef
  }
  const jiraTokenRef = raw_['jiraTokenRef']
  if (jiraTokenRef !== undefined) {
    if (typeof jiraTokenRef !== 'string' || jiraTokenRef === '') {
      throw new HttpError(400, 'jiraTokenRef 必须是非空字符串')
    }
    if (kind !== 'server') {
      throw new HttpError(400, 'jiraTokenRef 仅 server 站点使用（cloud 用 atlassianTokenRef）')
    }
    site.jiraTokenRef = jiraTokenRef
  }
  const confluenceTokenRef = raw_['confluenceTokenRef']
  if (confluenceTokenRef !== undefined) {
    if (typeof confluenceTokenRef !== 'string' || confluenceTokenRef === '') {
      throw new HttpError(400, 'confluenceTokenRef 必须是非空字符串')
    }
    if (kind !== 'server') {
      throw new HttpError(400, 'confluenceTokenRef 仅 server 站点使用（cloud 两产品共用一份 token）')
    }
    site.confluenceTokenRef = confluenceTokenRef
  }
  const projects = raw_['projects']
  if (projects !== undefined) {
    if (!Array.isArray(projects) || projects.some((entry) => typeof entry !== 'string')) {
      throw new HttpError(400, 'projects 必须是字符串数组')
    }
    // 输入宽容（小写 / 混分隔），存储归一为大写去重；空数组视为未配置。
    const keys = [
      ...new Set(
        projects.map((entry) => (entry as string).trim().toUpperCase()).filter((entry) => entry !== ''),
      ),
    ]
    const invalid = keys.find((key) => !PROJECT_KEY_PATTERN.test(key))
    if (invalid !== undefined) {
      throw new HttpError(400, `项目键「${invalid}」需匹配 ${PROJECT_KEY_PATTERN.source}，如 ACME`)
    }
    if (keys.length > 0) site.projects = keys
  }
  const workspaces = raw_['workspaces']
  if (workspaces !== undefined) {
    if (
      !Array.isArray(workspaces) ||
      workspaces.some((entry) => typeof entry !== 'string' || (entry as string).trim() === '')
    ) {
      throw new HttpError(400, 'workspaces 必须是非空字符串数组')
    }
    const paths = [...new Set(workspaces.map((entry) => normalizeWorkspacePath(entry as string)))]
    if (paths.length > 0) site.workspaces = paths
  }
  if (raw_['default'] !== undefined) {
    if (typeof raw_['default'] !== 'boolean') throw new HttpError(400, 'default 必须是布尔值')
    if (raw_['default'] === true) site.default = true
  }
  // kind 分支已保证对应地址存在（cloud 的 atlassianUrl / server 的 jiraUrl + confluenceUrl）。
  return site as SiteDraft
}

export interface NormalizedSites {
  sites: SiteDraft[]
  problems: string[]
}

/** 行 config 里的 sites 数组规范化：非法行降级为 problems，不炸整表。 */
export function normalizeSites(raw: unknown): NormalizedSites {
  if (raw === undefined || raw === null) return { sites: [], problems: [] }
  if (!Array.isArray(raw)) return { sites: [], problems: ['sites 必须是数组'] }
  const sites: SiteDraft[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  for (const [index, entry] of raw.entries()) {
    let site: SiteDraft
    try {
      site = validateSiteDraft(entry)
    } catch (error) {
      const label =
        typeof (entry as Record<string, unknown>)?.['name'] === 'string'
          ? (entry as { name: string }).name
          : `第 ${index + 1} 行`
      problems.push(`站点「${label}」无效：${errMsg(error)}`)
      continue
    }
    if (seen.has(site.name)) {
      problems.push(`站点「${site.name}」重名，仅保留第一条`)
      continue
    }
    seen.add(site.name)
    sites.push(site)
  }
  if (sites.filter((site) => site.default === true).length > 1) {
    let kept = false
    sites.forEach((site) => {
      if (site.default === true) {
        if (kept) delete site.default
        else kept = true
      }
    })
    problems.push('多个站点标记了 default，仅保留第一个')
  }
  return { sites, problems }
}

/** 工作区路径归一：统一正斜杠、去尾分隔符；Windows 比较时再忽略大小写。 */
export function normalizeWorkspacePath(path: string): string {
  return path
    .trim()
    .replace(/[/\\]+$/, '')
    .replace(/\\/g, '/')
}

/** cwd 命中判定：等于配置目录，或位于其子目录下（前缀 + 路径边界）。 */
export function workspaceMatches(entry: string, cwd: string, caseInsensitive: boolean): boolean {
  const e = normalizeWorkspacePath(entry)
  const w = normalizeWorkspacePath(cwd)
  const e_ = caseInsensitive ? e.toLowerCase() : e
  const w_ = caseInsensitive ? w.toLowerCase() : w
  return w_ === e_ || w_.startsWith(`${e_}/`)
}

/**
 * 站点选择语义（工具、命令共用一套），按顺序：
 * 1. 显式 site 参数——存在即以其为准，不存在报错列名；
 * 2. 当前工作区（主视图会话 cwd）命中站点 workspaces 且**唯一**命中一站——自动选它；
 * 3. hint（工单号 / JQL / CQL）命中站点 projects 里的键且**唯一**命中一站——自动选它；
 * 4. 默认站点；5. 全表仅一站；6. 报错列出可选站点名（绝不猜）。
 */
export interface SiteChoiceRequest {
  name?: string
  hint?: string
  /** 当前会话工作目录（client 上报的主视图 cwd）；缺失时跳过工作区匹配。 */
  workspaceCwd?: string
}

export function chooseSite(
  sites: SiteDraft[],
  request: SiteChoiceRequest,
  options: { caseInsensitive?: boolean } = {},
): SiteDraft {
  const caseInsensitive = options.caseInsensitive === true
  if (request.name !== undefined) {
    const chosen = sites.find((site) => site.name === request.name)
    if (chosen !== undefined) return chosen
    throw new HttpError(
      400,
      `站点「${request.name}」不存在，可选站点：${sites.map((site) => site.name).join('、')}`,
    )
  }
  if (request.workspaceCwd !== undefined && request.workspaceCwd !== '') {
    const cwd = request.workspaceCwd
    const matched = sites.filter((site) =>
      (site.workspaces ?? []).some((entry) => workspaceMatches(entry, cwd, caseInsensitive)),
    )
    if (matched.length === 1) return matched[0]
  }
  if (request.hint !== undefined && request.hint !== '') {
    const matched = sites.filter((site) =>
      (site.projects ?? []).some((key) => new RegExp(`\\b${key}\\b`, 'i').test(request.hint!)),
    )
    if (matched.length === 1) return matched[0]
  }
  const chosen = sites.find((site) => site.default === true) ?? (sites.length === 1 ? sites[0] : undefined)
  if (chosen === undefined) {
    throw new HttpError(
      400,
      `多站点环境需指明 site 参数或设置默认站点，可选站点：${sites.map((site) => site.name).join('、')}`,
    )
  }
  return chosen
}

function readRow(ctx: Context): Record<string, unknown> {
  const row = ctx.configEditor.configuration().find((item) => item.entry.options.id === ROW_ID)
  if (row === undefined) throw new HttpError(503, '插件行不在配置表中，无法读取站点（请确认插件已启用）')
  // 与官方卡片同口径：profile 覆盖非空以覆盖为准，否则取下层组合值。
  return Object.keys(row.override).length > 0 ? row.override : (row.inherited as Record<string, unknown>)
}

export interface SitesManager {
  /** when 条件用的快照值：至少一个站点配置了可用凭据。 */
  usableCount(): number
  refresh(): Promise<void>
  /** 当前会话工作目录（client 上报的主视图 cwd）；undefined = 尚未上报。 */
  workspaceCwd(): string | undefined
  /** cwd 桥写入：client 订阅推送与面板 list 请求兜底共用。 */
  setWorkspaceCwd(cwd: string | undefined): void
  /** 每次工具/命令调用现读现解析；hint 是调用内容用于项目键自动匹配。 */
  requireSite(name: string | undefined, hint?: string): SiteDraft
  /** Jira 凭据（cloud 兼作 Confluence）。 */
  jiraTokenOf(site: SiteDraft): Promise<string>
  /** Confluence 凭据（Server 独立 PAT；cloud 与 Jira 同一凭据）。 */
  confluenceTokenOf(site: SiteDraft): Promise<string>
  describeTokens(
    site: SiteDraft,
  ): Promise<{ token: CredentialStateView; confluenceToken: CredentialStateView }>
  view(): Promise<SitesView>
  save(request: {
    site: SiteDraft
    token?: string
    confluenceToken?: string
    previousName?: string
  }): Promise<void>
  remove(name: string): Promise<void>
  clearToken(name: string, product: 'jira' | 'confluence'): Promise<void>
}

export function createSitesManager(ctx: Context): SitesManager {
  let usableCount = 0
  let workspaceCwd: string | undefined
  // Windows 路径大小写不敏感（NTFS 惯例），其余平台保留大小写比较。
  const caseInsensitive = process.platform === 'win32'

  const rowEntry = (): ReturnType<Context['configEditor']['entries']>[number] | undefined =>
    ctx.configEditor.entries().find((item) => item.options.id === ROW_ID)

  function describeTokenOf(ctx: Context, ref: string): Promise<CredentialStateView> {
    return (async () => {
      try {
        const info = await ctx.credentials.describe(ref as CredentialRef)
        return { configured: info.configured, source: info.source }
      } catch (error) {
        return { configured: false, failure: errMsg(error) }
      }
    })()
  }

  const describeTokens = (site: SiteDraft) =>
    describeTokenOf(ctx, jiraTokenRefOf(site)).then(async (token) => ({
      token,
      confluenceToken: site.kind === 'cloud' ? token : await describeTokenOf(ctx, confluenceTokenRefOf(site)),
    }))

  /** 快照刷新：apply 时与每次写路由后调用（配置变更本就走 fiber 重挂）。 */
  async function refresh(): Promise<void> {
    const { sites } = normalizeSites(readRow(ctx).sites)
    let count = 0
    for (const site of sites) {
      const tokens = await describeTokens(site)
      // 任一产品凭据可用即计入：另一产品缺席在调用时报 409 并指明引用名。
      if (tokens.token.configured || tokens.confluenceToken.configured) count += 1
    }
    usableCount = count
  }

  async function editSites(change: (sites: SiteDraft[]) => SiteDraft[]): Promise<void> {
    const entry = rowEntry()
    if (entry === undefined) throw new HttpError(503, '插件行不在配置表中，无法写入站点（请确认插件已启用）')
    await ctx.configEditor.edit(entry, (current) => {
      const current_ = current as Record<string, unknown>
      const normalized = normalizeSites(current_['sites'])
      return { ...current_, sites: change(normalized.sites) }
    })
  }

  return {
    usableCount: () => usableCount,
    refresh,
    workspaceCwd: () => workspaceCwd,
    setWorkspaceCwd(cwd) {
      workspaceCwd = cwd
    },
    requireSite(name, hint) {
      const { sites } = normalizeSites(readRow(ctx).sites)
      if (sites.length === 0) {
        throw new HttpError(409, '未配置任何 Atlassian 站点：请到设置页添加站点并配置 token')
      }
      return chooseSite(sites, { name, hint, workspaceCwd }, { caseInsensitive })
    },
    async jiraTokenOf(site) {
      const ref = jiraTokenRefOf(site)
      const resolved = await ctx.credentials.resolve(ref as CredentialRef)
      if (resolved === undefined) {
        throw new HttpError(
          409,
          `站点「${site.name}」的 Jira token 未配置（凭据 ${ref}：可在设置页填入，或以环境变量提供）`,
        )
      }
      return resolved.value
    },
    async confluenceTokenOf(site) {
      const ref = confluenceTokenRefOf(site)
      const resolved = await ctx.credentials.resolve(ref as CredentialRef)
      if (resolved === undefined) {
        throw new HttpError(
          409,
          `站点「${site.name}」的 Confluence token 未配置（凭据 ${ref}：可在设置页填入，或以环境变量提供）`,
        )
      }
      return resolved.value
    },
    describeTokens,
    async view() {
      const { sites, problems } = normalizeSites(readRow(ctx).sites)
      const views: SiteView[] = []
      for (const site of sites) {
        views.push({ ...site, ...(await describeTokens(site)) })
      }
      return { sites: views, problems }
    },
    async save({ site, token, confluenceToken, previousName }) {
      await editSites((sites) => {
        const without = sites.filter(
          (existing) =>
            existing.name !== site.name && (previousName === undefined || existing.name !== previousName),
        )
        if (site.default === true) {
          return [
            ...without.map((existing) => ({ ...existing, default: undefined as boolean | undefined })),
            site,
          ]
        }
        return [...without, site]
      })
      if (token !== undefined && token !== '') {
        await ctx.credentials.set(jiraTokenRefOf(site) as CredentialRef, token)
      }
      if (confluenceToken !== undefined && confluenceToken !== '' && site.kind === 'server') {
        await ctx.credentials.set(confluenceTokenRefOf(site) as CredentialRef, confluenceToken)
      }
      await refresh()
    },
    async remove(name) {
      const { sites } = normalizeSites(readRow(ctx).sites)
      const removed = sites.find((site) => site.name === name)
      await editSites((current) => current.filter((site) => site.name !== name))
      if (removed !== undefined) {
        await ctx.credentials.unset(jiraTokenRefOf(removed) as CredentialRef)
        if (removed.kind === 'server') {
          await ctx.credentials.unset(confluenceTokenRefOf(removed) as CredentialRef)
        }
      }
      await refresh()
    },
    async clearToken(name, product) {
      const { sites } = normalizeSites(readRow(ctx).sites)
      const site = sites.find((entry) => entry.name === name)
      if (site === undefined) throw new HttpError(404, `站点「${name}」不存在`)
      await ctx.credentials.unset(
        (product === 'confluence' ? confluenceTokenRefOf(site) : jiraTokenRefOf(site)) as CredentialRef,
      )
      await refresh()
    },
  }
}

async function describeTokenOf(ctx: Context, ref: string): Promise<CredentialStateView> {
  try {
    const info = await ctx.credentials.describe(ref as CredentialRef)
    return { configured: info.configured, source: info.source }
  } catch (error) {
    return { configured: false, failure: errMsg(error) }
  }
}
