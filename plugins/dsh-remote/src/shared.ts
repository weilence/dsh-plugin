/**
 * dsh-remote 线协议与共享常量：host 桥与 client 面板共用的类型和规则。
 *
 * 一个「远程开发连接」描述一台远端机上的完整 dsh web 实例：经用户自备
 * 的 OpenSSH 别名（认证完全复用 ~/.ssh/config）部署、启动、端口转发与
 * 断开。三类同步能力（skills / MCP / 插件）全部由本插件拥有，dsh-skills
 * 与 dsh-mcp 保持纯本地管理插件、不感知远端。
 *
 * 远端默认只装 dsh-remote——其余插件（dsh-mcp、dsh-skills 等）由
 * 「同步本地插件」按勾选经远端 `dsh plugin add` 安装、manifest 跟踪式
 * 移除，远端手装插件零接触。
 */

/** 官方 MCP client 插件的模块名（远端 patch 下发行的 name 字段）。 */
export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'

/** 本插件包名（scoped，weilence.com 域名空间；裸名 dsh-remote 在 npm 已被第三方占用，
 *  远端安装因此不走 registry——部署时本地打包 tgz 推送，见 engine runDeploy）。 */
export const REMOTE_PLUGIN_NAME = '@weilence/dsh-remote'

/** 远端实例的 profile：固定 web（shipped 模板含 dsh-web-app，token 行 / 端口转发的
 *  前提），不可配置（面板无此输入）。headless 模板无 web-app——其参数解析器
 *  不认 --no-open / --port，也永不输出 `dsh web:` 就绪行，起不了可转发的实例。 */
export const REMOTE_PROFILE = 'web'

/** sshAlias 的合法性（OpenSSH 别名字符集，拒绝 shell 元字符）。 */
export const SSH_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** 连接 id 的合法性。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

/** host 桥自定义头（client POST 携带，折进 CORS 预检）。 */
export const BRIDGE_HEADER = 'x-dsh-remote'

/** 非本地（registry 形态）插件的远端安装方式：本地打包传输 / 远端自行 npm 下载。
 *  本地路径安装（link:/file:）的插件不受此选项影响——永远本地传输（开发中的
 *  未发布代码也只有这条路径能到达远端）。 */
export type RegistryPluginInstall = 'push' | 'remote'

// ---- 连接 profile（$DSH_HOME/dsh-remote.json 持久化） ----

/** 一个远程开发连接的持久化声明。 */
export interface RemoteConnection {
  id: string
  label: string
  /** OpenSSH 主机别名——唯一凭据来源，本插件不读写任何私钥材料。 */
  sshAlias: string
  sync: {
    /** 标记「跑在远端」的本机 MCP serverName 清单。 */
    mcpServerNames: string[]
    /** 同步到远端的本地插件名清单（manifest 跟踪式安装 / 移除）。 */
    pluginNames: string[]
    /** 非本地插件的安装方式（本地插件恒本地传输，不受此选项影响）。 */
    registryPluginInstall: RegistryPluginInstall
  }
  createdAt: string
  updatedAt: string
}

// ---- 运行态快照（内存，不持久化） ----

/** SSH 失败的错误分类（面板按类给修复指引）。 */
export type SshErrorKind =
  'auth-failed' | 'unreachable' | 'remote-cmd-failed' | 'timeout' | 'local-tool-missing' | 'unknown'

/** 连接生命周期相位。 */
export type ConnPhase = 'idle' | 'probing' | 'deploying' | 'starting' | 'running' | 'stopping' | 'error'

/** 进行中的操作（互斥：op 非空时拒绝新操作）。 */
export interface ConnOp {
  kind: 'test' | 'deploy' | 'connect' | 'disconnect' | 'sync-skills' | 'sync-mcp' | 'sync-plugins'
  /** 当前步进（deploy 的 node/npm/install-dsh…，连接的 start/poll/forward…）。 */
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
    skills: { at: string; pushed: number; deleted: number; skipped: number } | null
    mcp: { at: string; installed: string[]; removed: string[] } | null
    plugins: { at: string; installed: string[]; removed: string[]; skipped: string[] } | null
  }
}

/** 面板一行：持久化声明 + 运行态快照。 */
export type ConnRow = RemoteConnection & { state: ConnState }

// ---- 本机环境与清单 ----

/** 本机工具探针结果（ssh / tar 缺席时面板置顶告警并禁用操作）。 */
export interface LocalEnv {
  profileName: string | null
  /** $DSH_HOME 绝对路径（同步源与存储定位用）。 */
  home: string
  ssh: boolean
  tar: boolean
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
  mcpRows: LocalMcpRow[]
  pluginRows: LocalPluginRow[]
  /** profileContext 缺席（非 profile 启动）时为 false，清单为空。 */
  available: boolean
}

// ---- wire 请求 / 响应 ----

export interface SaveRequest {
  /** 编辑时的连接 id；缺省为新建。 */
  id?: string
  label: string
  sshAlias: string
  sync: {
    mcpServerNames: string[]
    pluginNames: string[]
    /** 非本地插件安装方式；缺省 'remote'（远端自行下载）。 */
    registryPluginInstall?: RegistryPluginInstall
  }
}

export interface SaveResponse {
  id: string
}

export interface DeleteRequest {
  id: string
}

export interface StateResponse {
  env: LocalEnv
  connections: ConnRow[]
}

export interface TestRequest {
  id: string
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

export interface SyncRequest {
  id: string
  kind: SyncKind
}

/** serverName → 稳定 patch 行 id（与 dsh-mcp 同口径）。 */
export function mcpRowIdOf(serverName: string): string {
  return `mcp-${serverName}`
}
