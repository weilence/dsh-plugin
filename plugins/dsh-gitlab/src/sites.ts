import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import { errMsg } from '@dsh-plugins/shared'
import { HttpError } from '@dsh-plugins/shared/http'
import { resolveGlabStatus, runGlab } from './glab'
import { ROW_ID, SITE_NAME_PATTERN, type GlabStatusView, type SiteDraft, type SitesView } from './shared'

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
    throw new HttpError(400, `站点名需匹配 ${SITE_NAME_PATTERN.source}，如 yamu`)
  }
  const url = raw_['url']
  if (typeof url !== 'string' || url === '') throw new HttpError(400, '站点需要 GitLab 根地址（url）')
  const site: SiteDraft = { name, url: normalizeUrl(url, 'url') }
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
  return site
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
 * 站点选择语义（工具与测试探测共用一套），按顺序：
 * 1. 显式 site 参数——存在即以其为准，不存在报错列名；
 * 2. 当前工作区（主视图会话 cwd）命中站点 workspaces 且**唯一**命中一站——自动选它；
 * 3. 默认站点；4. 全表仅一站；5. 报错列出可选站点名（绝不猜）。
 */
export interface SiteChoiceRequest {
  name?: string
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

export interface SitesManagerOptions {
  /** 测试注入：跳过真实 glab 二进制探测，直接采用该状态。 */
  glab?: GlabStatusView
  /** 测试注入：`glab --version` 探测替身；缺省真 spawn。 */
  run?: typeof runGlab
}

export interface SitesManager {
  /** when 条件用的快照值：glab 可用且至少配置了一个站点。 */
  usable(): boolean
  refresh(): Promise<void>
  /** 当前会话工作目录（client 上报的主视图 cwd）；undefined = 尚未上报。 */
  workspaceCwd(): string | undefined
  /** cwd 桥写入：client 订阅推送与面板 list 请求兜底共用。 */
  setWorkspaceCwd(cwd: string | undefined): void
  /** glab 二进制解析快照（apply 与每次写路由后的 refresh 结果）。 */
  glabStatus(): GlabStatusView
  /** 每次工具调用现读站点配置。 */
  requireSite(name: string | undefined): SiteDraft
  view(): Promise<SitesView>
  save(request: { site: SiteDraft; previousName?: string }): Promise<void>
  remove(name: string): Promise<void>
}

export function createSitesManager(ctx: Context, options: SitesManagerOptions = {}): SitesManager {
  let sites: SiteDraft[] = []
  let problems: string[] = []
  let glab: GlabStatusView = { path: null }
  let usable = false
  let workspaceCwd: string | undefined
  // Windows 路径大小写不敏感（NTFS 惯例），其余平台保留大小写比较。
  const caseInsensitive = process.platform === 'win32'

  const rowEntry = (): ReturnType<Context['configEditor']['entries']>[number] | undefined =>
    ctx.configEditor.entries().find((item) => item.options.id === ROW_ID)

  /** 快照刷新：apply 时与每次写路由后调用（配置变更本就走 fiber 重挂）。 */
  async function refresh(): Promise<void> {
    const row = readRow(ctx)
    const normalized = normalizeSites(row.sites)
    sites = normalized.sites
    problems = normalized.problems
    glab =
      options.glab ??
      (await resolveGlabStatus(typeof row.glabPath === 'string' ? row.glabPath : undefined, {
        env: process.env,
        platform: process.platform,
        run: options.run ?? runGlab,
      }))
    usable = sites.length > 0 && glab.path !== null
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
    usable: () => usable,
    refresh,
    workspaceCwd: () => workspaceCwd,
    setWorkspaceCwd(cwd) {
      workspaceCwd = cwd
    },
    glabStatus: () => glab,
    requireSite(name) {
      const { sites: current } = normalizeSites(readRow(ctx).sites)
      if (current.length === 0) {
        throw new HttpError(409, '未配置任何 GitLab 站点：请在插件详情页添加站点')
      }
      return chooseSite(current, { name, workspaceCwd }, { caseInsensitive })
    },
    async view() {
      await refresh()
      return { sites: [...sites], problems, glab }
    },
    async save({ site, previousName }) {
      await editSites((current) => {
        const without = current.filter(
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
      await refresh()
    },
    async remove(name) {
      await editSites((current) => current.filter((site) => site.name !== name))
      await refresh()
    },
  }
}
