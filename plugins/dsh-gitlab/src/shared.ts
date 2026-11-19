/** 双端 wire 类型与常量：插件面板 ↔ host 路由；工具名也以此为单一事实源。 */

export const ROW_ID = 'dsh-gitlab'
export const API_HEADER = 'x-dsh-gitlab'

/** 站点名（小写 slug）约束：工具 site 参数与面板校验共用。 */
export const SITE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

export const SITES_PATH = '/dsh-gitlab/sites'
export const SAVE_PATH = '/dsh-gitlab/save'
export const DELETE_PATH = '/dsh-gitlab/delete'
export const TEST_PATH = '/dsh-gitlab/test'
export const CWD_PATH = '/dsh-gitlab/cwd'

export interface SiteDraft {
  /** 站点名（小写 slug），工具 site 参数按它寻址。 */
  name: string
  /** GitLab 站点根地址（如 https://gitlab.example.com）。 */
  url: string
  /** 关联工作区的目录路径（归一为正斜杠、无尾分隔符）；当前会话工作目录唯一命中时优先选此站点。 */
  workspaces?: string[]
  /** 多站点时的缺省站点；全表至多一个为 true。 */
  default?: boolean
}

/** glab 二进制探测结果（面板的第一排查入口）。 */
export interface GlabStatusView {
  /** 探测到的可执行文件路径；未找到为 null。 */
  path: string | null
  /** `glab --version` 首行（如 glab 1.124.0 (...)）。 */
  version?: string
  /** 未找到或版本探测失败的原文。 */
  error?: string
}

export type SiteView = SiteDraft

export interface SitesView {
  sites: SiteView[]
  /** 配置里无法通过校验的原始行原因（工具一律忽略这些行）。 */
  problems: string[]
  glab: GlabStatusView
}

export interface SaveRequest {
  site: SiteDraft
  /** 提供即视为改名：先移除旧名再写入新名。 */
  previousName?: string
}

export interface DeleteRequest {
  name: string
}

export interface TestRequest {
  /** 可为未保存的草稿。 */
  site: SiteDraft
}

/** 探测 = `glab api user --hostname <host>`：ok 携带登录名，失败携带 glab 原样报错。 */
export interface TestResponse {
  ok: boolean
  user?: string
  reason?: string
}

/** 工作区 cwd 上报（client 主视图会话桥）；cwd 缺省 = 工作区未定。 */
export interface CwdRequest {
  cwd?: string
}

export const TOOL_GLAB = 'glab'

/** URL → GITLAB_HOST 主机名（含非默认端口、去路径）；协议非法抛出由校验拦截。 */
export function hostOf(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`站点地址协议必须是 http 或 https：${url}`)
  }
  return parsed.host
}
