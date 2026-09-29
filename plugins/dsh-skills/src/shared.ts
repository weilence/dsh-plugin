// 双端内联模块：不得引入 node: / 浏览器专属 API。
export const LIST_PATH = '/dsh-skills/list'
export const FILE_PATH = '/dsh-skills/file'
export const SAVE_PATH = '/dsh-skills/save'
export const DELETE_PATH = '/dsh-skills/delete'
export const GIT_SCAN_PATH = '/dsh-skills/git-scan'
export const GIT_INSTALL_PATH = '/dsh-skills/git-install'
export const GIT_CHECK_PATH = '/dsh-skills/git-check'
export const GIT_UPDATE_PATH = '/dsh-skills/git-update'

/** 官方 skill 名称文法（与 @deepseek-ai/dsh-skill 的 isSkillName 一致）。 */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * 可管理（可写）的技能根。与官方 skill-filesystem provider 的默认根一一
 * 对应（customSkillDirs 与 bundledSkillDir 属于组合层配置/安装目录，
 * 本插件视为只读来源，不纳入写入目标）。
 */
export type RootId = 'project-dsh' | 'project-agents' | 'user-dsh' | 'user-agents'

/** 一个可写技能根的描述（host 计算后经 wire 下发）。 */
export interface RootInfo {
  id: RootId
  /** 展示标签（中文，含路径语义）。 */
  label: string
  /** 根的绝对路径（host 本地路径）。 */
  path: string
  /** 根目录当前是否存在（不存在时新建技能会连带创建）。 */
  present: boolean
}

/** 面板里的一行技能：直接扫描条目或注册表补充行的投影。 */
export interface SkillRow {
  name: string
  description: string
  whenToUse?: string
  /** 是否进入模型可见目录与 skill 工具（frontmatter disable-model-invocation 的反面）。 */
  modelInvocable: boolean
  /** 是否进入用户命令目录（frontmatter user-invocable）。 */
  userInvocable: boolean
  /** 发现来源（project-dsh / user-agents / bundled / custom / runtime / …）。 */
  source: string
  /** 提供方名（scan / filesystem / runtime / …）。 */
  provider: string
  /** 技能文件绝对路径；虚拟技能（无文件）缺失。 */
  path?: string
  /** 命中的可写根；缺失 = 只读来源。 */
  rootId?: RootId
  /** rootId 存在即 editable。 */
  editable: boolean
  /** 该条目当前是否在本面板的合并视图里胜出（未被同名更低 rank 来源遮蔽）。 */
  effective: boolean
  /** 校验失败原因（frontmatter 不合官方规则）；缺失 = 合法。 */
  invalid?: string
  /** 文件形态。 */
  format?: SkillFormat
  /** Git 安装来源（读写根内 .dsh-skills.json 索引命中时下发）。 */
  git?: GitSourceInfo
}

/** GET /dsh-skills/list 响应。 */
export interface ListResponse {
  roots: RootInfo[]
  skills: SkillRow[]
}

/** GET /dsh-skills/file 响应：技能文件原文（含 frontmatter）。 */
export interface FileResponse {
  path: string
  raw: string
}

/** 技能文件形态：根目录单文件 `<name>.md` 或目录包 `<name>/SKILL.md`。 */
export type SkillFormat = 'flat' | 'bundle'

/** POST /dsh-skills/save 请求。 */
export interface SaveRequest {
  /** 工作区级作用域（工作区 cwd）；缺失 = 仅全局根。 */
  cwd?: string
  /** 新建时的目标根（编辑时忽略，以 editPath 所属根为准）。 */
  rootId: RootId
  name: string
  /** 新建时的形态；编辑时忽略（沿用原文件形态）。 */
  format?: SkillFormat
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  /** Markdown 指令正文（不含 frontmatter）。 */
  body: string
  /** 编辑模式：被覆盖的技能文件绝对路径（来自 list 下发的 path）。 */
  editPath?: string
}

/** POST /dsh-skills/save 响应。 */
export interface SaveResponse {
  path: string
}

/** POST /dsh-skills/delete 请求。 */
export interface DeleteRequest {
  cwd?: string
  path: string
}

/** Git 安装技能在行上的来源信息（list 时由根级索引文件合并）。 */
export interface GitSourceInfo {
  /** 安装时的仓库地址（回指更新的依据）。 */
  url: string
  /** 技能目录在仓库内的相对路径（posix 分隔）。 */
  dir: string
  /** 安装 / 最近更新时的 HEAD 提交号（短 7 位；缺失 = 未知）。 */
  commit?: string
  /** 安装 / 最近更新时间（ISO）。 */
  installedAt: string
}

/** 根级 Git 索引文件（<root>/.dsh-skills.json）里的一条安装记录。 */
export interface GitSkillRecord {
  url: string
  dir: string
  origin: GitSkillCandidate['origin']
  /** 安装时仓库 HEAD（缺失 = 记录时不可得）。 */
  commit?: string
  /** 安装时目录内容哈希（检出本地修改的基线）。 */
  contentHash?: string
  installedAt: string
}

/** Git 仓库里发现的一个技能候选。 */
export interface GitSkillCandidate {
  /** 技能目录在仓库内的相对路径（posix 分隔，安装请求按它回指）。 */
  dir: string
  /** 安装名（frontmatter name；缺省回退目录名）。 */
  name: string
  description: string
  whenToUse?: string
  /** 发现位置：marketplace / plugin.json 声明或标准技能目录。 */
  origin: 'marketplace' | 'plugin' | 'skills' | 'agents' | 'claude' | 'root'
  /** 校验问题（缺 description / 非法 name 等）；缺失 = 可安装。 */
  problem?: string
}

/** POST /dsh-skills/git-scan 请求。 */
export interface GitScanRequest {
  /** git 仓库地址（https:// / ssh:// / git@host:path）。 */
  url: string
  cwd?: string
}

/** POST /dsh-skills/git-scan 响应。 */
export interface GitScanResponse {
  skills: GitSkillCandidate[]
  /** 仓库级提示（跳过的外部插件等）。 */
  notes: string[]
}

/** POST /dsh-skills/git-install 请求。 */
export interface GitInstallRequest {
  url: string
  cwd?: string
  rootId: RootId
  /** 选中的候选目录（git-scan 下发的 dir 原值）。 */
  skills: string[]
}

/** POST /dsh-skills/git-install 响应：部分成功允许。 */
export interface GitInstallResponse {
  installed: { name: string; path: string }[]
  /** 目标根已有同名技能，未覆盖。 */
  conflicts: { name: string; path: string }[]
  failed: { name: string; error: string }[]
}

/** 检查更新的结果状态。 */
export type GitUpdateStatus =
  | 'current' // 已最新
  | 'update' // 上游有新版本，本地未动过
  | 'local' // 本地已修改（上游同时有新版本，更新会覆盖本地改动）
  | 'removed' // 上游已发现不到该技能目录

/** 单个技能的检查结果。 */
export interface GitCheckResult {
  rootId: RootId
  name: string
  dir: string
  status: GitUpdateStatus
  /** 上游候选的描述（有更新时的对照信息）。 */
  description?: string
}

/** POST /dsh-skills/git-check 请求（检查当前作用域全部 Git 安装技能）。 */
export interface GitCheckRequest {
  cwd?: string
  /** 'workspace' 只查项目根；缺省（'user'）只查用户根——与列表作用域一致。 */
  scope?: 'user' | 'workspace'
}

/** POST /dsh-skills/git-check 响应。 */
export interface GitCheckResponse {
  results: GitCheckResult[]
  /** 克隆失败的仓库及其原因（其下技能未判定）。 */
  repoErrors: { url: string; error: string }[]
}

/** POST /dsh-skills/git-update 请求。 */
export interface GitUpdateRequest {
  cwd?: string
  /** 'workspace' 只动项目根；缺省（'user'）只动用户根——与列表作用域一致。 */
  scope?: 'user' | 'workspace'
  skills: { rootId: RootId; name: string }[]
}

/** POST /dsh-skills/git-update 响应：部分成功允许。 */
export interface GitUpdateResponse {
  updated: { name: string; path: string }[]
  failed: { name: string; error: string }[]
  repoErrors: { url: string; error: string }[]
}

/** 来源的中文标签；未知来源回退原文。 */
export const SOURCE_LABELS: Record<string, string> = {
  'project-dsh': '工作区级 · .dsh/skills',
  'project-agents': '工作区级 · .agents/skills',
  custom: '自定义目录',
  'user-dsh': '全局 · ~/.dsh/skills',
  'user-agents': '全局 · ~/.agents/skills',
  bundled: '内置',
  runtime: '运行时',
}

/** 来源的稳定排序权重（与官方 rank 对齐，小者靠前）。 */
export const SOURCE_ORDER: Record<string, number> = {
  'project-dsh': 100,
  'project-agents': 200,
  custom: 300,
  'user-dsh': 400,
  'user-agents': 500,
  bundled: 600,
  runtime: 700,
}

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source
}

export function sourceOrder(source: string): number {
  return SOURCE_ORDER[source] ?? 800
}
