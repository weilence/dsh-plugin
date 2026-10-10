export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** 本插件包名（scoped，weilence.com 域名空间；无 scope 包名 dsh-remote 在 npm 已被第三方占用，
 *  远端安装因此不走 registry——部署时本地打包 tgz 推送，见 engine ensureDeployed）。 */
export const REMOTE_PLUGIN_NAME = '@weilence/dsh-remote'

/** 是否本插件自身（当前 scoped 包名或改名前的旧包名 dsh-remote）：远端装配的基线，不进同步清单。 */
export function isRemoteSelf(name: string): boolean {
  return name === REMOTE_PLUGIN_NAME || name === 'dsh-remote'
}

/** 远端实例的 profile：固定 web（shipped 模板含 dsh-web-app，token 行 / 端口转发的
 *  前提），不可配置（面板无此输入）。headless 模板无 web-app——其参数解析器
 *  不认 --no-open / --port，也永不输出 `dsh web:` 就绪行，起不了可转发的实例。 */
export const REMOTE_PROFILE = 'web'

/** sshAlias 的合法性（OpenSSH 别名字符集，拒绝 shell 元字符）。 */
export const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 连接 id 的合法性。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** host 路由路径（client api.ts 复用，端点单源）。 */
export const STATE_PATH = '/dsh-remote/state'
export const LOCAL_ROWS_PATH = '/dsh-remote/local-rows'
export const SAVE_PATH = '/dsh-remote/save'
export const DELETE_PATH = '/dsh-remote/delete'
export const TEST_PATH = '/dsh-remote/test'
export const REMOTE_INVENTORY_PATH = '/dsh-remote/remote-inventory'
export const CONNECT_PATH = '/dsh-remote/connect'
export const VERSION_PATH = '/dsh-remote/version'
export const SYNC_PATH = '/dsh-remote/sync'

/** 非本地（registry 形态）插件的远端安装方式：本地打包传输 / 远端自行 npm 下载。
 *  本地路径安装（link:/file:）的插件不受此选项影响——永远本地传输（开发中的
 *  未发布代码也只有这条路径能到达远端）。 */
export type RegistryPluginInstall = 'push' | 'remote'

/** 一个远程开发连接的持久化声明（同步勾选不持久化——随 POST /sync 直传）。 */
export interface RemoteConnection {
  id: string
  label: string
  /** OpenSSH 主机别名——唯一凭据来源，本插件不读写任何私钥材料。 */
  sshAlias: string
  createdAt: string
  updatedAt: string
}

/** SSH 失败的错误分类（面板按类给修复指引）。 */
export type SshErrorKind =
  'auth-failed' | 'unreachable' | 'remote-cmd-failed' | 'timeout' | 'local-tool-missing' | 'unknown'

/** 连接生命周期阶段（无「断开」操作：本地转发随宿主退出或意外中断消失，
 *  远端实例常驻由用户自理）。 */
export type ConnPhase = 'idle' | 'probing' | 'deploying' | 'starting' | 'running' | 'error'

/** 进行中的操作（互斥：op 非空时拒绝新操作）。文字进度不在此——面板用
 *  spinner 呈现进行中，过程细节见 progress 时间线。 */
export interface ConnOp {
  kind: 'test' | 'connect' | 'sync-skills' | 'sync-mcp' | 'sync-plugins' | 'sync-prompts'
}

/** 操作步骤时间线的一项（进行中 hover 浮层与失败详情弹窗共用）。 */
export interface OpStep {
  /** 步骤名（host 侧事实，如 probe-node / push，原样展示不翻译）。 */
  step: string
  /** 步骤补充说明（版本号、插件名等）。 */
  detail?: string
  at: string
}

/** 最近一次操作的记录；下一次操作开始时清空，成功失败都保留至彼时。 */
export interface ConnProgress {
  kind: ConnOp['kind']
  steps: OpStep[]
}

/** running 阶段的事实（token URL 由启动日志解析而来）。 */
export interface ConnRunning {
  url: string
  localPort: number
  remotePort: number
  /** 远端实例 pid（版本不符或实例无响应时重启用）。 */
  pid: number
  since: string
}

/** 连接的运行态快照（GET /state 的组成部分）。 */
export interface ConnState {
  phase: ConnPhase
  op: ConnOp | null
  /** 最近一次操作的 kind 与步骤时间线（进行中浮层 / 失败详情弹窗用）。 */
  progress: ConnProgress | null
  running: ConnRunning | null
  /** 最近一次操作的错误（message 为单行摘要；detail 为完整输出，面板「查看完整」
   *  弹窗用）；同步失败时连接仍可处于 running。 */
  error: { message: string; kind: SshErrorKind; detail?: string } | null
  /** 最近一次各同步的结果摘要（面板展示用；同步只新增/覆盖，skipped = 已一致跳过）。 */
  lastSync: {
    skills: { at: string; pushed: number } | null
    mcp: { at: string; installed: string[] } | null
    plugins: { at: string; installed: string[] } | null
    prompts: { at: string; pushed: boolean } | null
  }
}

/** 一个条目与远端比对后的结论：same 跳过写入，diff 覆盖，absent 远端安装，
 *  unknown 值读不出——一律按 diff 保守执行（宁可重推不可漏装）。 */
export type ItemStatus = 'same' | 'diff' | 'absent' | 'unknown'

/** 递归按 key 排序的稳定 JSON：两侧 YAML 键序 / 注释差异不参与相等性。 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** MCP 行的生效配置签名（config 与 disabled 一并入签，弹窗徽标与引擎跳过共用）。 */
export function mcpSignature(config: Record<string, unknown>, disabled: boolean): string {
  return canonicalJson({ config, disabled })
}

/** 远端一个技能的事实（digest = 内容摘要；null = 远端摘要管道失败）。 */
export interface RemoteSkillFact {
  name: string
  digest: string | null
}

/** 远端一条 MCP 行的事实（按 serverName 对齐）。 */
export interface RemoteMcpFact {
  serverName: string
  signature: string
  /** 传输形态摘要（弹窗「远端：…」对比行用）。 */
  summary: string
}

/** 远端一个插件的事实（列表恒为 bundles 激活清单；version null = 读不到）。 */
export interface RemotePluginFact {
  name: string
  version: string | null
}

export function skillStatus(local: string | null, remote: RemoteSkillFact | undefined): ItemStatus {
  if (remote === undefined) return 'absent'
  if (local === null || remote.digest === null) return 'unknown'
  return local === remote.digest ? 'same' : 'diff'
}

/** 系统提示词（system-prompt.md）的远端事实；null = 读取失败（无法比对，同步侧保守推送）。 */
export interface RemotePromptFact {
  exists: boolean
  /** 存在时的内容摘要；读不到（权限等）为 null。 */
  digest: string | null
}

export function promptStatus(local: string, remote: RemotePromptFact | null): ItemStatus {
  if (remote === null) return 'unknown'
  if (!remote.exists) return 'absent'
  if (remote.digest === null) return 'unknown'
  return local === remote.digest ? 'same' : 'diff'
}

export function mcpStatus(localSignature: string, remote: RemoteMcpFact | undefined): ItemStatus {
  if (remote === undefined) return 'absent'
  return remote.signature === localSignature ? 'same' : 'diff'
}

/** 插件条目比对（remote 缺席 = 远端 bundles 未激活，任侧值缺失 = 无法比对）。
 *  比对值恒为版本号——npm 语义下版本即内容契约，本地打包传输与远端 npm 下载
 *  同判；同版本换内容不可见，改码推远端必须 bump version。 */
export function pluginStatus(local: string | null, remote: string | null | undefined): ItemStatus {
  if (remote === undefined) return 'absent'
  if (local === null || remote === null) return 'unknown'
  return local === remote ? 'same' : 'diff'
}

/** 面板一行：持久化声明 + 运行态快照。 */
export type ConnRow = RemoteConnection & { state: ConnState }

/** 本机工具探针结果（ssh / tar 缺失时面板置顶告警并禁用操作）。 */
export interface LocalEnv {
  profileName: string | null
  /** $DSH_HOME 绝对路径（同步源与存储定位用）。 */
  home: string
  ssh: boolean
  tar: boolean
}

/** 本机技能行（两个用户级根扫描，供勾选同步）。 */
export interface LocalSkillRow {
  name: string
  /** 所在根：$DSH_HOME/skills 或 ~/.agents/skills。 */
  root: 'user-dsh' | 'user-agents'
  /** frontmatter 的 description（提取失败为 null）。 */
  description: string | null
  /** 内容摘要（技能全部文件的折叠指纹；读取失败为 null → 按无法比对处理）。 */
  digest: string | null
}

/** 本机 MCP 行（两层用户 patch 的只读清单，供勾选下发）。 */
export interface LocalMcpRow {
  /** patch 行 id（形如 mcp-<serverName>）。 */
  id: string
  serverName: string | null
  /** 传输形态摘要（stdio 命令或 http 端点）。 */
  summary: string
  /** 生效配置签名（config + disabled 的规范化 JSON）。 */
  signature: string
}

/** 本机插件行（两层用户 patch 的 insert 清单，供勾选同步到远端）。 */
export interface LocalPluginRow {
  /** patch 行 id。 */
  id: string
  /** 插件包名（同步安装的目标名）。 */
  name: string
  /** 声明所在层。 */
  source: 'profile' | 'home'
  /** 安装形态：本地路径（link:/file: spec）或 registry 依赖。 */
  install: 'local' | 'registry'
  /** 本机包根目录（local 为 spec 目标；registry 为层内 node_modules 实体）；定位失败为 null。 */
  root: string | null
  /** 本机包版本（root 下 package.json 的 version）；读取失败为 null。 */
  version: string | null
}

/** 本机系统提示词行（system-prompt.md——dsh-prompts 插件管理的同一文件）。 */
export interface LocalPromptRow {
  /** 本机文件绝对路径。 */
  path: string
  /** 内容摘要；文件不存在为 null（无可同步）。 */
  digest: string | null
}

/** GET /local-rows 的响应。 */
export interface LocalRowsResponse {
  skillRows: LocalSkillRow[]
  mcpRows: LocalMcpRow[]
  pluginRows: LocalPluginRow[]
  promptRow: LocalPromptRow
  /** profileContext 不可用（非 profile 启动）时为 false，清单为空。 */
  available: boolean
}

/** POST /remote-inventory 的响应：三类条目的远端事实（弹窗徽标与引擎跳过的
 *  同一判定源）。字段 null = 该类事实读取失败——弹窗按「无法比对」降级渲染，
 *  不阻断同步（同步只新增/覆盖，无删除风险）；ssh 连接级失败仍原样抛。 */
export interface RemoteInventoryResponse {
  /** 远端两个 skills 根的技能摘要（按根区分：本机同名技能在不同根是不同条目）。 */
  skills: Record<'user-dsh' | 'user-agents', RemoteSkillFact[] | null>
  /** 远端 profile patch 内 MCP 行（按 serverName 对齐）。 */
  mcp: RemoteMcpFact[] | null
  /** 远端 bundles 激活清单及各自已装版本。 */
  plugins: RemotePluginFact[] | null
  /** 远端系统提示词（system-prompt.md）事实；null = 读取失败。 */
  prompts: RemotePromptFact | null
}

export interface SaveRequest {
  /** 编辑时的连接 id；缺省为新建。 */
  id?: string
  label: string
  sshAlias: string
}

export interface StateResponse {
  env: LocalEnv
  connections: ConnRow[]
}

export interface TestResponse {
  ok: boolean
  nodeVersion: string | null
  npmVersion: string | null
  dshVersion: string | null
  error: { message: string; kind: SshErrorKind } | null
}

export interface OpRequest {
  id: string
}

export type SyncKind = 'skills' | 'mcp' | 'plugins' | 'prompts'

/** POST /sync：勾选清单随请求直传（提交即执行——勾选项全量安装/覆盖；
 *  未勾选 = 不动——同步只往远端新增/覆盖，永不删除远端内容）。 */
export interface SyncRequest {
  id: string
  kind: SyncKind
  /** 勾选项（skills 技能名 / MCP serverName / 插件包名 / prompts 恒为 system-prompt.md）。 */
  names: string[]
  /** 非本地插件安装方式（仅 plugins 类别；缺省 'remote'）。 */
  registryPluginInstall?: RegistryPluginInstall
}
