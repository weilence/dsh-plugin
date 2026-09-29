// dsh-remote 线协议与共享常量：host 桥与 client 面板共用的类型和规则。
// 同步为声明式语义：勾选=安装/升级、未勾选且远端已有=删除，删除范围恒为
// 本机清单∩远端清单，远端独有条目零接触——本约束贯穿全部三类同步。

/** 官方 MCP client 插件的模块名（远端 patch 下发行的 name 字段）。 */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** 本插件包名（scoped，weilence.com 域名空间；裸名 dsh-remote 在 npm 已被第三方占用，
 *  远端安装因此不走 registry——部署时本地打包 tgz 推送，见 engine ensureDeployed）。 */
export const REMOTE_PLUGIN_NAME = '@weilence/dsh-remote'

/** 是否本插件自身（scoped 包名或改名前的旧裸名行）：远端装配的基线，不进同步清单。 */
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

/** host 桥路由路径（client api.ts 复用，端点单源）。 */
export const STATE_PATH = '/dsh-remote/state'
export const LOCAL_ROWS_PATH = '/dsh-remote/local-rows'
export const SAVE_PATH = '/dsh-remote/save'
export const DELETE_PATH = '/dsh-remote/delete'
export const TEST_PATH = '/dsh-remote/test'
export const REMOTE_INVENTORY_PATH = '/dsh-remote/remote-inventory'
export const CONNECT_PATH = '/dsh-remote/connect'
export const DISCONNECT_PATH = '/dsh-remote/disconnect'
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

/** 连接生命周期相位。 */
export type ConnPhase = 'idle' | 'probing' | 'deploying' | 'starting' | 'running' | 'stopping' | 'error'

/** 进行中的操作（互斥：op 非空时拒绝新操作）。 */
export interface ConnOp {
  kind: 'test' | 'connect' | 'disconnect' | 'sync-skills' | 'sync-mcp' | 'sync-plugins'
  /** 当前步进（连接的部署段 probe-node/install-dsh…、启动段 start/poll/forward…）。 */
  step?: string
  /** 步进的补充说明（版本号、插件名等）。 */
  detail?: string
}

/** running 相位的事实（token URL 由启动日志解析而来）。 */
export interface ConnRunning {
  url: string
  localPort: number
  remotePort: number
  /** 远端实例 pid（断开时 kill 用）。 */
  pid: number
  since: string
}

/** 连接的运行态快照（GET /state 的组成部分）。 */
export interface ConnState {
  phase: ConnPhase
  op: ConnOp | null
  running: ConnRunning | null
  /** phase = error 时的错误事实。 */
  error: { message: string; kind: SshErrorKind } | null
  /** 最近一次各同步的结果摘要（面板展示用）。 */
  lastSync: {
    skills: { at: string; pushed: number; deleted: number } | null
    mcp: { at: string; installed: string[]; removed: string[] } | null
    plugins: { at: string; installed: string[]; removed: string[]; skipped: string[] } | null
  }
}

/** 面板一行：持久化声明 + 运行态快照。 */
export type ConnRow = RemoteConnection & { state: ConnState }

/** 本机工具探针结果（ssh / tar 缺席时面板置顶告警并禁用操作）。 */
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
}

/** 本机 MCP 行（两层用户 patch 的只读清单，供勾选下发）。 */
export interface LocalMcpRow {
  /** patch 行 id（形如 mcp-<serverName>）。 */
  id: string
  serverName: string | null
  /** 传输形态摘要（stdio 命令或 http 端点）。 */
  summary: string
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

/** GET /local-rows 的响应。 */
export interface LocalRowsResponse {
  skillRows: LocalSkillRow[]
  mcpRows: LocalMcpRow[]
  pluginRows: LocalPluginRow[]
  /** profileContext 缺席（非 profile 启动）时为 false，清单为空。 */
  available: boolean
}

/** POST /remote-inventory 的响应：远端三类清单（同步弹窗的默认勾选源——
 *  远端已有即默认勾选；条目级差异对比的判定后续迭代）。 */
export interface RemoteInventoryResponse {
  /** 远端两个 skills 根下的技能名（.md 单文件已剥后缀）。 */
  skills: string[]
  /** 远端 profile patch 内 MCP 行的 serverName。 */
  mcp: string[]
  /** 远端 profile dsh.profile.bundles 的包名（含 shipped base，消费侧按本机清单交集）。 */
  plugins: string[]
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

export type SyncKind = 'skills' | 'mcp' | 'plugins'

/** POST /sync：勾选清单随请求直传（声明式同步的目标态——勾选=安装/升级，
 *  未勾选且远端已有=删除）。 */
export interface SyncRequest {
  id: string
  kind: SyncKind
  /** 勾选项（skills 技能名 / MCP serverName / 插件包名）。 */
  names: string[]
  /** 非本地插件安装方式（仅 plugins 类别；缺省 'remote'）。 */
  registryPluginInstall?: RegistryPluginInstall
}
