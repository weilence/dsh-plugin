/** 双端 wire 类型与常量：插件面板 ↔ host 路由；工具名与命令名也以此为单一事实源。 */

export const ROW_ID = 'dsh-atlassian'
export const API_HEADER = 'x-dsh-atlassian'

/** 站点名（小写 slug）约束：工具 site 参数、凭据引用名派生与面板校验共用。 */
export const SITE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/** Jira 项目键 / Confluence 空间键约束：大写字母开头、2-10 位大写字母数字。 */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/

export const SITES_PATH = '/dsh-atlassian/sites'
export const SAVE_PATH = '/dsh-atlassian/save'
export const DELETE_PATH = '/dsh-atlassian/delete'
export const CLEAR_TOKEN_PATH = '/dsh-atlassian/clear-token'
export const TEST_PATH = '/dsh-atlassian/test'
export const CWD_PATH = '/dsh-atlassian/cwd'

export type SiteKind = 'cloud' | 'server'

export interface SiteDraft {
  /** 站点名（小写 slug），工具 `site` 参数与命令按它寻址。 */
  name: string
  kind: SiteKind
  /** Cloud：Atlassian 站点地址（如 https://acme.atlassian.net），Jira 与 Confluence 同域；仅 cloud。 */
  atlassianUrl?: string
  /** Server：Jira 根地址（必须显式是 Jira 的）；仅 server。 */
  jiraUrl?: string
  /** Server：Confluence 根地址（独立部署）；仅 server 必填。 */
  confluenceUrl?: string
  /** Cloud：API token 所属账号邮箱（Basic 认证用户名，两产品共用）。 */
  email?: string
  /** Cloud 凭据引用名（两产品共用）；缺省按 `ATLASSIAN_<NAME 大写下划线>_TOKEN` 派生。 */
  atlassianTokenRef?: string
  /** Server：Jira 凭据引用名；缺省按 `ATLASSIAN_<NAME>_JIRA_TOKEN` 派生。 */
  jiraTokenRef?: string
  /** Server：Confluence 独立凭据引用名；缺省按 `ATLASSIAN_<NAME>_CONFLUENCE_TOKEN` 派生。 */
  confluenceTokenRef?: string
  /**
   * 归属本站点的 Jira 项目键 / Confluence 空间键（全大写）。
   * 未指明 site 参数时，调用内容（工单号、JQL / CQL）命中且唯一命中一站的键可自动选站。
   */
  projects?: string[]
  /** 关联工作区的目录路径（归一为正斜杠、无尾分隔符）；当前会话工作目录唯一命中时优先选此站点。 */
  workspaces?: string[]
  /**
   * 评论过滤：displayName 命中（大小写不敏感子串）的作者，其评论不进 jira_get_issue 产物。
   * 用于机器账号（GitLab / CI 集成）刷屏淹没真实用户评论的站点。
   */
  commentExcludeAuthors?: string[]
  /** 多站点时的缺省站点；全表至多一个为 true。 */
  default?: boolean
}

/** 单产品的连接事实：地址已按 kind 归一（cloud 两产品同根），凭据由调用方按产品解析。 */
export interface ProductSite {
  name: string
  kind: SiteKind
  /** 该产品的 REST 根地址（不含 /rest/api 与 cloud 的 /wiki 前缀）。 */
  url: string
  /** Cloud：Basic 认证用户名。 */
  email?: string
}

/** Jira 侧连接事实：cloud 取 Atlassian 地址，server 取显式 Jira 地址。 */
export function jiraProductOf(site: SiteDraft): ProductSite {
  return {
    name: site.name,
    kind: site.kind,
    url: (site.kind === 'cloud' ? site.atlassianUrl : site.jiraUrl) ?? '',
    email: site.email,
  }
}

/** Confluence 侧连接事实：cloud 与 Atlassian 地址同域（/wiki 前缀由 client 加），server 取显式地址。 */
export function confluenceProductOf(site: SiteDraft): ProductSite {
  return {
    name: site.name,
    kind: site.kind,
    url: (site.kind === 'cloud' ? site.atlassianUrl : site.confluenceUrl) ?? '',
    email: site.email,
  }
}

/** 凭据状态视图：只表达「是否配置、来源」，永不携带值。 */
export interface CredentialStateView {
  configured: boolean
  source?: string
  /** describe 失败的原文（无法判定时出现）。 */
  failure?: string
}

export interface SiteView extends SiteDraft {
  /** Jira 凭据状态视图：只表达「是否配置、来源」，永不携带值。 */
  token: CredentialStateView
  /** Confluence 凭据状态视图（Server 独立 PAT；cloud 与 token 同一凭据）。 */
  confluenceToken: CredentialStateView
}

export interface SitesView {
  sites: SiteView[]
  /** 配置里无法通过校验的原始行原因（工具与命令一律忽略这些行）。 */
  problems: string[]
}

export interface SaveRequest {
  site: SiteDraft
  /** 提供即写入 Jira 凭据（cloud 兼作 Confluence）；undefined = 保留已存值（环境变量兜底不受影响）。 */
  token?: string
  /** Server / DC：提供即写入 Confluence 独立凭据；cloud 不接受。 */
  confluenceToken?: string
  /** 提供即视为改名：先移除旧名再写入新名。 */
  previousName?: string
}

export interface DeleteRequest {
  name: string
}

export interface ClearTokenRequest {
  name: string
  /** 缺省 jira；confluence = 清 Confluence 独立凭据（仅 Server / DC 有意义）。 */
  product?: 'jira' | 'confluence'
}

export interface TestRequest {
  /** 可为未保存的草稿；token 缺省时用该站点已存凭据。 */
  site: SiteDraft
  /** 提供即直接用该值探测 Jira（保存前验证新 token）。 */
  token?: string
  /** 提供即直接用该值探测 Confluence（保存前验证新 PAT）。 */
  confluenceToken?: string
}

/** 工作区 cwd 上报（client 主视图会话桥）；cwd 缺省 = 工作区未定。 */
export interface CwdRequest {
  cwd?: string
}

export interface ProductCheck {
  ok: boolean
  /** 失败原因（凭据/网络/权限的原样摘要）。 */
  reason?: string
}

export interface TestResponse {
  jira: ProductCheck
  confluence: ProductCheck
}

export const TOOL_JIRA_SEARCH = 'jira_search'
export const TOOL_JIRA_GET_ISSUE = 'jira_get_issue'
export const TOOL_CONF_SEARCH = 'confluence_search'
export const TOOL_CONF_GET_PAGE = 'confluence_get_page'

export const COMMAND_JIRA = 'jira'
export const COMMAND_CONF = 'conf'
