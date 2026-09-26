/**
 * dsh-skills 的 client ↔ host 桥共享契约（wire 类型 + 常量）。
 *
 * 本模块必须保持双端安全：不引入 node: 或浏览器专属 API，host half
 * （src/index.ts）与 client half（src/client/*）各自打包时都会内联它。
 */

/** 官方 skill 名称文法（@deepseek-ai/dsh-skill 的 isSkillName 同款）。 */
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
  /** 技能文件绝对路径；虚拟技能（无文件）缺席。 */
  path?: string
  /** 命中的可写根；缺席 = 只读来源。 */
  rootId?: RootId
  /** rootId 存在即 editable。 */
  editable: boolean
  /** 该条目当前是否在本面板的合并视图里胜出（未被同名更低 rank 来源遮蔽）。 */
  effective: boolean
  /** 校验失败原因（frontmatter 不合官方规则）；缺席 = 合法。 */
  invalid?: string
  /** 文件形态。 */
  format?: SkillFormat
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
  /** 项目作用域（工作区 cwd）；缺席 = 仅用户级根。 */
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

/** 来源的中文标签；未知来源回退原文。 */
export const SOURCE_LABELS: Record<string, string> = {
  'project-dsh': '项目 · .dsh/skills',
  'project-agents': '项目 · .agents/skills',
  custom: '自定义目录',
  'user-dsh': '用户 · ~/.dsh/skills',
  'user-agents': '用户 · ~/.agents/skills',
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
