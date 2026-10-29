import type { ForwardHandle, SshExec, SshTarget } from './ssh'
import { SshFailure, mergedOutput, shQuote, summarizeOutput } from './ssh'
import type { ForwardRegistry } from './forwards'
import { errMsg } from '@dsh-plugins/shared'
import { parseLaunchFromLog, rewriteLaunchUrl, type RemoteLaunch } from './launch'
import {
  buildHealthCommand,
  buildLaunchCommand,
  buildPollCommand,
  buildPortProbeCommand,
  buildStopCommand,
  buildUnitContent,
  buildUnitPortProbe,
  UNIT_LOG,
  UNIT_NAME,
  type ServicePaths,
} from './service'
import {
  normalizeConnection,
  normalizeSecret,
  normalizeTarget,
  readStore,
  toRemoteConnection,
  writeStore,
  ValidationError,
  type StoredConnection,
  type SyncManifest,
  type StoreFile,
} from './connections'
import {
  composeLocalRows,
  foldSkillDigest,
  mcpSummary,
  parseMcpServers,
  readLocalMcp,
  type LocalPatchLayer,
  type LocalMcpFile,
} from './localenv'
import {
  REMOTE_PLUGIN_NAME,
  REMOTE_PROFILE,
  compareDshVersion,
  dshDrift,
  isRemoteSelf,
  mcpSignature,
  preferredLocalTunnelPort,
  targetRequiresSecret,
  type ConnOp,
  type ConnRow,
  type ConnState,
  type RegistryPluginInstall,
  type RemoteInventoryResponse,
  type RemoteMcpFact,
  type RemotePluginFact,
  type RemotePromptFact,
  type RemoteSkillFact,
  type RunningHealth,
  type SaveRequest,
  type SshErrorKind,
  type SyncKind,
  type TestRequest,
  type TestResponse,
  type VersionDrift,
} from './shared'

/** 远端读插件事实的内嵌脚本（remotePluginFacts 经 ssh 执行）：输出行
 *  `<name>\t<version>`（空串 = 读不到）。 */
export const REMOTE_PLUGIN_FACTS_SCRIPT = [
  'const fs = require("fs")',
  'for (const n of process.argv.slice(1)) {',
  '  let v = ""',
  '  try { v = String(JSON.parse(fs.readFileSync(n + "/package.json", "utf8")).version ?? "") } catch {}',
  '  console.log(n + "\\t" + v)',
  '}',
].join('\n')

/** 标记行协议：远端探查命令以 `__KEY__<值>` 单行输出多个事实（值内换行由
 *  发送侧 tr 压平），一次建连拿全——Windows 无连接复用，必经探查从六次
 *  建连缩成一次。 */
function markedValues(stdout: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^__([A-Z]+)__(.*)$/.exec(line)
    if (match !== null) values.set(match[1], match[2])
  }
  return values
}

/** 工具链探查结果（null = 缺失；错误文本不冒充版本）。 */
export interface ToolProbe {
  node: string | null
  npm: string | null
  pnpm: string | null
}

/** 解析一次性工具链探查输出；畸形输出按整体不可用处理（保守失败）。 */
export function parseToolProbe(stdout: string): ToolProbe {
  const values = markedValues(stdout)
  const version = (key: string, pattern: RegExp): string | null => {
    const value = values.get(key)
    return value !== undefined && pattern.test(value) ? value : null
  }
  return {
    node: version('NODE', /^v\d/),
    npm: version('NPM', /^\d/),
    pnpm: version('PNPM', /^\d/),
  }
}

/** 解析服务事实探查输出（HOME / DSHBIN / PATH）：systemd 用户单元内容的原料，
 *  任一缺失为 null（由 ensureDeployed 在启动段前校验并显式报错）。端口不在其中
 *  ——它由既有单元或端口探测单独决定（见 parseUnitPort / parsePort）。 */
export function parseServiceProbe(stdout: string): Omit<ServicePaths, 'port'> | null {
  const values = markedValues(stdout)
  const home = values.get('HOME') ?? ''
  const dshPath = values.get('DSHBIN') ?? ''
  const path = values.get('PATH') ?? ''
  if (home === '' || dshPath === '' || path === '') return null
  return { home, dshPath, path }
}

/** 有效端口：非数字、privileged 端口（< 1024）与越界值一律不认。旧版本单元里
 *  的 `--port 0` 也在这一步被识别为「没有端口」，触发重选并改写单元。 */
export function parsePort(raw: string | undefined): number | null {
  if (raw === undefined || !/^[0-9]{1,5}$/.test(raw)) return null
  const port = Number(raw)
  return port >= 1024 && port <= 65535 ? port : null
}

/** 既有单元里的端口（部署段探查的 `__UNITPORT__` 标记）：有则沿用——端口稳定
 *  是「重启不换隧道」的前提，也是不每次重写单元、不额外 restart 的前提。 */
export function parseUnitPort(stdout: string): number | null {
  return parsePort(markedValues(stdout).get('UNITPORT'))
}

/** 存活核实结果（buildHealthCommand 的标记行）：systemd 眼中的单元状态 + 日志
 *  尾部。心跳判死之后才取一次，只读。 */
export interface LivenessFacts {
  /** ActiveState（active / activating / inactive / failed / …）；读不到为 null。 */
  active: string | null
  /** SubState（running / dead / auto-restart / …）；读不到为 null。 */
  sub: string | null
  /** NRestarts：systemd 自动拉起过几次；读不到为 null。 */
  restarts: number | null
  /** 日志尾部原文（远端把多行压成 `|`，这里还原）。 */
  log: string
  /** 远端没有 systemctl（单元不可能由 systemd 托管，按无法核实处理）。 */
  noSystemd: boolean
}

/** 解析存活核实输出；畸形输出按「读不到」处理（active 为 null），由调用方按
 *  无法核实降级——绝不在读不到状态时凭空判死并重启实例。 */
export function parseLivenessFacts(stdout: string): LivenessFacts {
  const values = markedValues(stdout)
  const active = (values.get('ACTIVE') ?? '').trim()
  const sub = (values.get('SUB') ?? '').trim()
  const restarts = Number.parseInt((values.get('RESTARTS') ?? '').trim(), 10)
  return {
    active: active.length === 0 ? null : active,
    sub: sub.length === 0 ? null : sub,
    restarts: Number.isInteger(restarts) ? restarts : null,
    log: (values.get('LOG') ?? '').replace(/\|+$/, '').split('|').join('\n'),
    noSystemd: values.has('NOSYSTEMD'),
  }
}

/** 经隧道问到的远端实例运行身份：ok 携带 apply 时定格的版本快照；404 =
 *  实例运行着未带版本接口的旧插件；其余失败（HTTP 状态或网络 / 认证错误）。
 *  语义见 host index.ts 的 instanceVersion 接线。 */
export type InstanceVersion =
  { ok: true; dsh: string | null; plugin: string | null } | { ok: false; http?: number; error?: string }

/** 引擎的外部效应面（测试注入 fake 用；生产接线见 host index.ts）。 */
export interface EngineDeps {
  exec: SshExec
  startForward(target: SshTarget, localPort: number, remotePort: number): Promise<ForwardHandle>
  freeLocalPort(): Promise<number>
  /** 本机 bind 探测指定端口：true = 当前空闲（首选隧道口启用前的探测）。探测
   *  与 ssh 实际 bind 之间仍有微小竞态，由转发段的「健康检查不过且转发进程已
   *  死 → 换临时端口重试一次」兜底。 */
  probeLocalPort(port: number): Promise<boolean>
  healthCheck(url: string): Promise<boolean>
  /** 经隧道问远端实例的运行版本（token 换 Cookie 后 GET /version）。 */
  instanceVersion(tunnelUrl: string): Promise<InstanceVersion>
  pushTar(target: SshTarget, localRoot: string, remoteRoot: string, names?: readonly string[]): Promise<void>
  /** 单文件二进制推送（tgz 落盘远端 payload 目录）。 */
  pushFile(target: SshTarget, localPath: string, remoteDir: string, fileName: string): Promise<void>
  readLocalLayers(): Promise<LocalPatchLayer[]>
  /** 本机全局 MCP 档（~/.dsh/mcp.json）：原始条目 + 弹窗行。 */
  readLocalMcp(): Promise<LocalMcpFile>
  scanSkills(): Promise<
    { key: 'user-dsh' | 'user-agents'; path: string; rows: { name: string; digest: string | null }[] }[]
  >
  /** 本机系统提示词（system-prompt.md）原文；文件不存在为 null。 */
  readSystemPrompt(): Promise<string | null>
  /** 本机 dsh 运行时版本的现读值（部署对齐目标 + 版本漂移基准）；读不到为
   *  null = 连接部署段直接失败（禁止回退安装 latest）。与 /version 自报的
   *  进程启动快照是两个口径：getDshRuntimeVersion 每次调用读盘，宿主磁盘不
   *  经本插件改动，现读能让「本机已升级、宿主未重启」立刻成为升级远端的依据；
   *  远端实例进程的磁盘会被部署段升级，其自报必须用快照（见 host index.ts）。 */
  currentDshVersion(): Promise<string | null>
  /** 本插件版本（package.json；部署版本对比目标）；未知为 null。 */
  localPluginVersion: string | null
  /** 本地打包本插件 tgz（部署自装用）；失败抛 SshFailure。 */
  packPlugin(): Promise<{ path: string; fileName: string }>
  /** 本地打包任意本机插件包根目录（插件同步传输用）；失败抛 SshFailure。 */
  packPackage(root: string): Promise<{ path: string; fileName: string }>
  /** 本地转发租约登记处：连接成功落盘、断开清除、load 清扫上个宿主生命周期遗留。 */
  forwards: ForwardRegistry
  homeDir: string
  now(): string
  delay(ms: number): Promise<void>
}

/** 操作被占用（路由转 409）。 */
export class BusyError extends Error {
  constructor(message = '该连接已有操作进行中') {
    super(message)
  }
}

/** 找不到连接（路由转 404）。 */
export class NotFoundError extends Error {
  constructor(id: string) {
    super(`没有找到 id 为「${id}」的连接`)
  }
}

/** 需要口令但当前没有（路由转 409，面板据此弹口令输入框）。 */
export class SecretRequiredError extends Error {
  constructor(message = '该连接需要登录密码：请先在面板输入密码') {
    super(message)
  }
}

/** 心跳看门狗的历史（独立于 running 事实：running 被重建时不清零，收敛次数
 *  才数得准）。 */
interface HealthRuntime {
  /** 上次探测时刻（epoch ms；NaN = 从没探过）。 */
  checkedAt: number
  /** 连续失败次数（成功即清零）。 */
  failures: number
  /** 连续成功次数：用于「稳定健康过一段时间」才清零收敛计数。 */
  okStreak: number
  /** 探测进行中（同一连接不并发探）。 */
  probing: boolean
  /** 在这之前不再探测（核实之后的退避，避免对坏实例刷 ssh）。 */
  pausedUntil: number
  /** 连续自动收敛次数：达到上限即判死并停手（防崩溃循环里无限重连）。 */
  recoveries: number
}

interface ConnRuntime {
  phase: ConnState['phase']
  op: ConnOp | null
  /** 最近一次操作的 kind 与步骤时间线（面板 spinner 浮层 / 失败详情弹窗）。 */
  progress: ConnState['progress']
  error: ConnState['error']
  running: ConnState['running']
  lastSync: ConnState['lastSync']
  forward: ForwardHandle | null
  health: HealthRuntime
}

function freshHealth(): HealthRuntime {
  return {
    checkedAt: Number.NaN,
    failures: 0,
    okStreak: 0,
    probing: false,
    pausedUntil: 0,
    recoveries: 0,
  }
}

function freshRuntime(): ConnRuntime {
  return {
    phase: 'idle',
    op: null,
    progress: null,
    error: null,
    running: null,
    lastSync: { skills: null, mcp: null, plugins: null, prompts: null },
    forward: null,
    health: freshHealth(),
  }
}

const CONNECT_POLL_INTERVAL_MS = 2_000
// 就绪窗口必须覆盖完整冷启动：MCP server 串行启动且各自现场下载依赖
// （npm / uv 各约 2 分钟，实测两个 MCP ≈ 4 分钟）——180s 会让「断开 → 重连」
// 这种必走冷启动的路径必然超时（实际发生过），放宽到 5 分钟。
const CONNECT_POLL_LIMIT_MS = 300_000
const HEALTH_RETRY = 8
const HEALTH_INTERVAL_MS = 1_000
const OP_TIMEOUT_MS = 600_000
/** 存活心跳间隔（面板轮询驱动；10s ≈ 每两次轮询探一次本地回环请求）。 */
const HEARTBEAT_INTERVAL_MS = 10_000
/** 连续失败多少轮才当回事：宿主休眠、systemd 重启窗口、远端瞬时卡顿都在这条
 *  阈值内被吸收；真正的死掉要 3 次 × 10s ≈ 30s 才判定。 */
const HEARTBEAT_FAILURE_LIMIT = 3
/** 核实之后的退避：实例「活着但不应答」时不要每 10s 建一次 ssh。 */
const HEALTH_PAUSE_MS = 60_000
/** 一轮掉线里最多自动收敛几次；连续健康两轮（≈20s）才把计数清零，防止
 *  「起来就崩」的实例把重连变成风暴。 */
const RECOVERY_LIMIT = 3
const RECOVERY_RESET_STREAK = 2

/** 旧 nohup 形态的 pid 文件路径（按连接 id 命名）：只服务升级后的迁移清理与
 *  停止收尾——单元名与日志路径已固定，不再由它派生。 */
function pidFileOf(id: string): string {
  return `~/.dsh/dsh-remote/${id}.pid`
}

export class RemoteEngine {
  private store: StoreFile = { version: 2, connections: [], manifest: {} }
  private readonly runtimes = new Map<string, ConnRuntime>()
  /** 「记住密码」关闭时的口令：只驻内存，宿主退出 / 删除连接 / 改认证方式即消失。 */
  private readonly sessionSecrets = new Map<string, string>()
  private loaded = false

  constructor(private readonly deps: EngineDeps) {}

  private runtimeOf(id: string): ConnRuntime {
    let runtime = this.runtimes.get(id)
    if (runtime === undefined) {
      runtime = freshRuntime()
      this.runtimes.set(id, runtime)
    }
    return runtime
  }

  private manifestOf(id: string): SyncManifest {
    return this.store.manifest[id] ?? { skills: {}, mcp: [], plugins: [], prompts: false }
  }

  private async persist(): Promise<void> {
    await writeStore(this.deps.homeDir, this.store)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.store = await readStore(this.deps.homeDir)
    // 上个宿主生命周期遗留的本地转发：杀进程 + 清租约（宿主被 SIGKILL / 崩溃
    // 时不走 dispose 兜底），重启后的 idle 才不带幽灵隧道
    await this.deps.forwards.sweep()
    for (const connection of this.store.connections) this.runtimeOf(connection.id)
    this.loaded = true
  }

  rows(): ConnRow[] {
    return this.store.connections.map((connection) => ({
      ...toRemoteConnection(connection, this.sessionSecrets.has(connection.id)),
      state: this.stateOf(connection.id),
    }))
  }

  stateOf(id: string): ConnState {
    const runtime = this.runtimeOf(id)
    return {
      phase: runtime.phase,
      op: runtime.op === null ? null : { ...runtime.op },
      progress:
        runtime.progress === null
          ? null
          : { kind: runtime.progress.kind, steps: runtime.progress.steps.map((step) => ({ ...step })) },
      running: runtime.running,
      error: runtime.error,
      lastSync: {
        skills: runtime.lastSync.skills === null ? null : { ...runtime.lastSync.skills },
        mcp: runtime.lastSync.mcp === null ? null : { ...runtime.lastSync.mcp },
        plugins: runtime.lastSync.plugins === null ? null : { ...runtime.lastSync.plugins },
        prompts: runtime.lastSync.prompts === null ? null : { ...runtime.lastSync.prompts },
      },
    }
  }

  connectionOf(id: string): StoredConnection {
    const connection = this.store.connections.find((candidate) => candidate.id === id)
    if (connection === undefined) throw new NotFoundError(id)
    return connection
  }

  /** 当前可用口令：落盘优先，其次本次运行的内存口令；别名恒为 null。 */
  private secretOf(connection: StoredConnection): string | null {
    if (connection.target.kind === 'alias') return null
    return connection.secret ?? this.sessionSecrets.get(connection.id) ?? null
  }

  /** 引擎各流程统一用「连接目标 + 当前口令」调用 ssh。 */
  private sshTargetOf(connection: StoredConnection): SshTarget {
    return { target: connection.target, secret: this.secretOf(connection) }
  }

  private ensureSecret(connection: StoredConnection): void {
    if (targetRequiresSecret(connection.target) && this.secretOf(connection) === null) {
      throw new SecretRequiredError()
    }
  }

  /** 保存后的口令落点：记住 → 落盘由连接携带；不记住 → 只进内存；清除 → 两处都删。 */
  private stashSecret(connection: StoredConnection, secret: string | null): void {
    if (secret === null || connection.secret !== null) this.sessionSecrets.delete(connection.id)
    else this.sessionSecrets.set(connection.id, secret)
  }

  async save(request: SaveRequest): Promise<{ id: string }> {
    await this.load()
    const previous = request.id === undefined ? undefined : this.connectionOf(request.id)
    // save 只管基本信息；运行中修改会让转发进程锚在旧目标上。没有「断开」
    // 操作，改目标的路径是删除后重建。同步勾选不经 save（随 startSync 直传），
    // 无此限制。
    if (previous !== undefined && this.runtimeOf(previous.id).running !== null) {
      throw new BusyError('连接使用中不能修改基本信息；如需更换目标请删除连接后重建')
    }
    const ids = new Set(
      this.store.connections
        .filter((candidate) => candidate.id !== previous?.id)
        .map((candidate) => candidate.id),
    )
    const normalized = await normalizeConnection(
      request,
      ids,
      this.deps.now(),
      previous,
      // 表单留空 = 保持：来源是「实际可用」的口令，可能只在内存里
      previous === undefined ? null : this.secretOf(previous),
    )
    const connection = normalized.connection
    if (previous === undefined) this.store.connections.push(connection)
    else
      this.store.connections = this.store.connections.map((row) =>
        row.id === connection.id ? connection : row,
      )
    this.runtimeOf(connection.id)
    this.stashSecret(connection, normalized.secret)
    await this.persist()
    return { id: connection.id }
  }

  async remove(id: string): Promise<void> {
    await this.load()
    this.connectionOf(id)
    const runtime = this.runtimeOf(id)
    if (runtime.op !== null) throw new BusyError()
    // 删除 = 本地全清（转发与租约随记录消失，运行中也可删）；远端实例与
    // ~/.dsh/dsh-remote/ 产物保留，由用户自理（与 dispose 同一语义）。
    runtime.forward?.kill()
    runtime.forward = null
    await this.deps.forwards.clear(id)
    this.store.connections = this.store.connections.filter((candidate) => candidate.id !== id)
    delete this.store.manifest[id]
    this.runtimes.delete(id)
    this.sessionSecrets.delete(id)
    await this.persist()
  }

  /** 现场补口令（POST /secret）：只进内存，永不落盘。 */
  async setSessionSecret(id: string, secret: string): Promise<void> {
    await this.load()
    const connection = this.connectionOf(id)
    if (connection.target.kind === 'alias') {
      throw new ValidationError('别名连接的认证由 ~/.ssh/config 决定，不使用面板口令')
    }
    const value = normalizeSecret(secret)
    if (value === null || value === undefined) throw new ValidationError('口令不能为空')
    this.sessionSecrets.set(id, value)
  }

  /** 同步预占操作位（互斥在事件循环同一 tick 内完成，双击不会双跑）。
   *  本机缺 ssh 的失败分类由 ssh 执行器在 spawn 时给出（local-tool-missing）。 */
  private beginOp(id: string, op: ConnOp, phase: ConnRuntime['phase']): StoredConnection {
    const connection = this.connectionOf(id)
    // 密码登录却没有可用口令（典型：宿主重启后会话口令丢了）：显式要口令，
    // 不把一次注定失败的认证当成连接失败
    this.ensureSecret(connection)
    const runtime = this.runtimeOf(id)
    if (runtime.op !== null) throw new BusyError()
    runtime.op = op
    // 新操作开始即重置过程时间线（旧过程随上一操作的终态展示完它的使命）
    runtime.progress = { kind: op.kind, steps: [] }
    runtime.error = null
    runtime.phase = phase
    return connection
  }

  private settle(id: string, phase: ConnRuntime['phase']): void {
    const runtime = this.runtimeOf(id)
    runtime.op = null
    runtime.phase = phase
  }

  private fail(id: string, error: unknown): void {
    const runtime = this.runtimeOf(id)
    // 同步操作的失败不等于连接中断；连接或断开失败则不能留下无主转发。
    const keepForward = runtime.op?.kind.startsWith('sync-') && runtime.running !== null
    if (!keepForward) {
      runtime.forward?.kill()
      runtime.forward = null
      runtime.running = null
    }
    runtime.op = null
    runtime.phase = keepForward ? 'running' : 'error'
    runtime.error =
      error instanceof SshFailure
        ? { message: error.message, kind: error.kind, detail: error.detail }
        : { message: errMsg(error), kind: 'unknown' }
  }

  private step(id: string, step: string, detail?: string): void {
    const runtime = this.runtimeOf(id)
    if (runtime.progress === null) return
    runtime.progress = {
      ...runtime.progress,
      steps: [...runtime.progress.steps, { step, detail, at: this.deps.now() }],
    }
  }

  private restPhase(runtime: ConnRuntime): 'idle' | 'running' {
    return runtime.running !== null ? 'running' : 'idle'
  }

  /**
   * 表单里的无状态探针（POST /test）：不占连接操作位、不改卡片阶段、不需要
   * 先保存——只回报远端 node / npm / dsh 三段版本。口令来源：表单本次输入的
   * 优先，其次 id 对应连接的已保存 / 会话口令。
   */
  async probe(request: TestRequest): Promise<TestResponse> {
    await this.load()
    const target = await normalizeTarget(request.target)
    const submitted = normalizeSecret(request.secret)
    const secret =
      submitted !== undefined
        ? submitted
        : request.id === undefined
          ? null
          : this.secretOf(this.connectionOf(request.id))
    if (targetRequiresSecret(target) && secret === null) throw new SecretRequiredError()
    const sshTarget: SshTarget = { target, secret }
    try {
      const combined = await this.deps.exec(sshTarget, 'node -v && npm -v && (dsh -V || true)', {
        timeoutMs: 20_000,
      })
      const lines = combined.stdout.trim().split(/\r?\n/)
      return {
        ok: true,
        nodeVersion: lines[0] ?? null,
        npmVersion: lines[1] ?? null,
        dshVersion: lines[2] && lines[2].length > 0 ? lines[2] : null,
        error: null,
      }
    } catch (error) {
      const failure = error instanceof SshFailure ? error : new SshFailure('unknown', errMsg(error))
      if (failure.kind === 'remote-cmd-failed') {
        // 连接通但 node 缺失：算探针结果而非连接故障
        const node = await this.deps.exec(sshTarget, 'node -v || true')
        return {
          ok: false,
          nodeVersion: node.code === 0 && node.stdout.trim().length > 0 ? node.stdout.trim() : null,
          npmVersion: null,
          dshVersion: null,
          error: { message: failure.message, kind: failure.kind },
        }
      }
      return {
        ok: false,
        nodeVersion: null,
        npmVersion: null,
        dshVersion: null,
        error: { message: failure.message, kind: failure.kind },
      }
    }
  }

  startConnect(id: string): void {
    const connection = this.beginOp(id, { kind: 'connect' }, 'deploying')
    this.step(id, 'probe-node')
    void this.runConnect(connection)
  }

  /** 连接的部署段：环境探针 + dsh 版本对齐 + 本插件安装；已装齐时立即完成。
   *  失败原样抛给 runConnect 的 catch 统一 fail（error 阶段）。
   *  十项只读事实（node/npm/pnpm/dsh 版本、插件 package.json、profile 登记、
   *  HOME / dsh 路径 / 登录 PATH 三项服务事实、既有单元端口）经一条标记行命令
   *  一次拿全——探查彼此无依赖，Windows（无连接复用）下必经建连从十次缩成一次。
   *  端口只在单元里没有有效值时才探测（多一次建连，仅首连 / 旧单元迁移时发生）。
   *  wantVersion 由 runConnect 传入（本机现读目标，与实例版本判定共用同一值）。
   *  dsh 对齐是方向感知的：远端旧于目标才安装升级；远端新于目标**不降级**
   *  （本机落后不强制，返回值 machine.dsh 记远端实际版本，由面板提示升级本机）。
   *  返回值还携带机器事实（node / npm / dsh，与表单「测试」同一组查询的定格），
   *  由 runConnect 写进 running 供面板展示。 */
  private async ensureDeployed(
    id: string,
    wantVersion: string,
  ): Promise<{ paths: ServicePaths; machine: { node: string; npm: string; dsh: string } }> {
    const target = this.sshTargetOf(this.connectionOf(id))
    const remoteModulePkg = `~/.dsh/profiles/${REMOTE_PROFILE}/node_modules/${REMOTE_PLUGIN_NAME}/package.json`
    const remoteProfilePkg = `~/.dsh/profiles/${REMOTE_PROFILE}/package.json`

    this.step(id, 'probe', 'node / npm / pnpm / dsh / systemd')
    const probeCommand = [
      'echo __NODE__"$(node -v 2>&1)"',
      'echo __NPM__"$(npm -v 2>&1)"',
      'echo __PNPM__"$(pnpm -v 2>&1)"',
      'echo __DSH__"$(dsh -V 2>&1)"',
      `echo __PLUGIN__"$(cat ${remoteModulePkg} 2>/dev/null | tr -d '\\n\\r')"`,
      `(grep -q ${shQuote(REMOTE_PLUGIN_NAME)} ${remoteProfilePkg} && echo __REG__1) || echo __REG__0`,
      'echo __HOME__"$HOME"',
      'echo __DSHBIN__"$(command -v dsh 2>/dev/null)"',
      'echo __PATH__"$PATH"',
      buildUnitPortProbe(),
    ].join('; ')
    const probe = await this.deps.exec(target, probeCommand)
    const tools = parseToolProbe(probe.stdout)
    const probeDetail = mergedOutput(probe.stdout, probe.stderr)
    if (tools.node === null)
      throw new SshFailure('remote-cmd-failed', '远端未安装 Node（需 ≥22.19）', probeDetail)
    if (tools.npm === null) throw new SshFailure('remote-cmd-failed', '远端未安装 npm', probeDetail)

    // pnpm 缺失不自动装（corepack enable 会写系统目录且新版 Node 不再附带）：
    // 显式失败并指路，由用户在远端自行装好后重试。
    if (tools.pnpm === null) {
      throw new SshFailure(
        'remote-cmd-failed',
        '远端未安装 pnpm：请在远端执行 corepack enable 或 npm install -g pnpm 后重试（插件安装依赖它）',
        probeDetail,
      )
    }
    this.step(id, 'ensure-pnpm', `node ${tools.node} / npm ${tools.npm} / pnpm ${tools.pnpm}`)

    // 远端 dsh 版本对齐本机；目标（本机现读）解析失败直接终止——npm 的 latest
    // 标签可能落后于 next（实测 latest=0.1.7-rc.2、0.2 线在 next），回退安装会
    // 装出旧版本线，触发插件的 engines 版本闸门。null 在 runConnect 已拦截。
    this.step(id, 'install-dsh', wantVersion)
    const remoteDshRaw = markedValues(probe.stdout).get('DSH')
    // 服务事实取自探查；dsh 此刻未装（路径空）时由安装命令附带补齐——npm 全局
    // bin 目录在装与不装之间不变，但路径必须以装完后的实况为准。
    let servicePaths = parseServiceProbe(probe.stdout)
    // 远端 dsh 的实际版本：装与不装都以最终事实为准（machine.dsh 面板展示用）。
    // 未装（命令输出错误文本）或输出畸形时在安装分支里被替换为 wantVersion。
    let effectiveDsh = remoteDshRaw ?? ''
    const relation = remoteDshRaw === undefined ? null : compareDshVersion(remoteDshRaw, wantVersion)
    if (relation !== null && relation > 0) {
      // 远端新于本机：不降级（本机落后只提示不强制）——磁盘与进程保持一致的
      // 较新版本，降级会让下次 systemd 重启把实例拉回旧版本线
      this.step(id, 'dsh-newer', `远端 dsh ${remoteDshRaw} 新于本机 ${wantVersion}，跳过降级`)
    } else if (remoteDshRaw !== wantVersion) {
      const install = await this.deps.exec(
        target,
        `npm install -g ${shQuote(`@deepseek-ai/dsh@${wantVersion}`)} && echo __DSHBIN__"$(command -v dsh 2>/dev/null)"`,
        {
          timeoutMs: OP_TIMEOUT_MS,
        },
      )
      if (install.code !== 0) {
        // pnpm/npm 的真实错误常打在 stdout，摘要与全文都合并两路输出
        throw new SshFailure(
          'remote-cmd-failed',
          `远端安装 @deepseek-ai/dsh 失败：${summarizeOutput(install.stdout, install.stderr)}`,
          mergedOutput(install.stdout, install.stderr),
        )
      }
      // 装完后补齐的 dsh 路径覆盖探查值（探查时未装为空）
      const afterInstall = parseServiceProbe(install.stdout)
      if (afterInstall !== null) servicePaths = afterInstall
      effectiveDsh = wantVersion
    }

    // 远端默认只装本插件——tgz 推送安装（无 scope 包名 dsh-remote 在 npm 已被第三方
    // 包占用，不能走 registry）；版本与 profile 登记都一致时跳过。
    this.step(id, 'install-plugin', REMOTE_PLUGIN_NAME)
    const localPluginVersion = this.deps.localPluginVersion
    let remoteVersion: string | null = null
    try {
      const parsed = JSON.parse(markedValues(probe.stdout).get('PLUGIN') ?? '') as {
        version?: unknown
      }
      remoteVersion = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
    } catch {
      // 未安装（cat 空）或输出异常：都按未安装处理
    }
    const registered = markedValues(probe.stdout).get('REG') === '1'
    if (registered && remoteVersion !== null && remoteVersion === localPluginVersion) {
      this.step(id, 'verify', `已装 ${REMOTE_PLUGIN_NAME}@${remoteVersion}，跳过`)
    } else {
      const packed = await this.deps.packPlugin()
      this.step(id, 'push', packed.fileName)
      await this.deps.pushFile(target, packed.path, '~/.dsh/dsh-remote/payload', packed.fileName)
      this.step(id, 'install-plugin', packed.fileName)
      const add = await this.deps.exec(
        target,
        `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add "$HOME/.dsh/dsh-remote/payload/${packed.fileName}" && echo __VERIFY__"$(cat ${remoteModulePkg} | tr -d '\\n\\r')"`,
        {
          timeoutMs: OP_TIMEOUT_MS,
        },
      )
      if (add.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端安装 ${REMOTE_PLUGIN_NAME} 失败：${summarizeOutput(add.stdout, add.stderr)}`,
          mergedOutput(add.stdout, add.stderr),
        )
      }
      // 假阳性防线：add 退出码 0 不等于装上——输出末尾读回的版本确认（与 add
      //  同一条连接，多行 JSON 已压平进标记行）
      this.step(id, 'verify')
      let settledVersion: string | null = null
      try {
        const parsed = JSON.parse(markedValues(add.stdout).get('VERIFY') ?? '') as {
          version?: unknown
        }
        settledVersion =
          typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
      } catch {
        // 读不回即视为未装上
      }
      if (settledVersion === null) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端 ${REMOTE_PLUGIN_NAME} 安装后读不回 package.json：请重跑部署并查看远端 pnpm 输出`,
        )
      }
      if (localPluginVersion !== null && settledVersion !== localPluginVersion) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端装上的版本 ${settledVersion} 与本机 ${localPluginVersion} 不一致`,
        )
      }
    }

    // systemd 服务事实齐备才能进启动段（unit 内容的原料）——缺失即显式报错，
    // 不回退 nohup（远端不支持 systemd 是用户决策下的硬性要求）
    if (servicePaths === null) {
      throw new SshFailure(
        'remote-cmd-failed',
        '远端服务事实探测不全（HOME / dsh 路径 / PATH 任一为空）：无法生成 systemd 用户单元，已中止',
        mergedOutput(probe.stdout, probe.stderr),
      )
    }
    // 端口优先沿用既有单元：同一端口意味着重启（systemd 自动拉起 / 版本收敛）
    // 之后既有隧道与浏览器会话都不用重来。只有单元里没有有效端口（首连，或旧
    // 版本的 `--port 0`）才探测一次。
    const port = parseUnitPort(probe.stdout) ?? (await this.choosePort(target))
    this.step(id, 'port', String(port))
    return {
      paths: { ...servicePaths, port },
      // dsh 取对齐后的实际版本：部署段要么装成 wantVersion、要么远端本就更新
      // （跳过降级，记远端实际值）；node / npm 是探查原值（面板行展示的事实）
      machine: { node: tools.node, npm: tools.npm, dsh: effectiveDsh },
    }
  }

  /** 无既有端口时的远端端口探测（loopback 试绑候选表，全占用则内核分配）。 */
  private async choosePort(target: SshTarget): Promise<number> {
    const probe = await this.deps.exec(target, buildPortProbeCommand(), { timeoutMs: 20_000 })
    const port = parsePort(markedValues(probe.stdout).get('PORT'))
    if (port === null) {
      throw new SshFailure(
        'remote-cmd-failed',
        '远端无法确定实例监听端口（端口探测没有有效输出）：请确认远端 node 可用后重试',
        mergedOutput(probe.stdout, probe.stderr),
      )
    }
    return port
  }

  /** 手动升级远端（running 卡片在「远端可升级」时出现的动作，POST /upgrade）：
   *  与连接 / 自动恢复同一流程——部署段幂等把远端 dsh 与插件对齐到本机现读
   *  版本，旧实例在版本判定处被 stop 后重启收敛，全程进度走 spinner 浮层。 */
  startUpgradeRemote(id: string): void {
    const connection = this.beginOp(id, { kind: 'upgrade' }, 'deploying')
    this.step(id, 'upgrade', '对齐远端到本机版本')
    void this.runConnect(connection)
  }

  private async runConnect(connection: StoredConnection): Promise<void> {
    const id = connection.id
    try {
      const target = this.sshTargetOf(connection)
      const runtime = this.runtimeOf(id)
      // 重连先杀旧转发：error 阶段重连时旧句柄仍在（fail 不清 forward），不杀
      // 会被新 forward 覆盖句柄，泄漏为无主 ssh 进程（实测累积过 4 个）
      runtime.forward?.kill()
      runtime.forward = null
      runtime.running = null

      // 本机现读目标版本（部署对齐 + 实例判定的同一基准）；读不到直接中止——
      // 禁止回退安装 npm latest 的论证见 ensureDeployed。
      const targetVersion = await this.deps.currentDshVersion()
      if (targetVersion === null) {
        throw new SshFailure(
          'unknown',
          '本机 dsh 运行时版本探测失败（@deepseek-ai/dsh-app-boot 不可达）：远端不回退安装 latest，已中止装配',
        )
      }

      // 部署段先行（幂等，已装齐时直接跳过）；装配完成进入启动段（阶段驱动面板 pill）
      const { paths: servicePaths, machine } = await this.ensureDeployed(id, targetVersion)
      runtime.phase = 'starting'

      // 复用实例先验明正身再接受：版本快照由实例自报（进程内 apply 时定格，
      // 部署段事后升级磁盘换不动活进程），与本机不一致（本机已升级 / 远端是
      // 未带版本接口的旧插件）或复用实例无响应时杀旧重启收敛一次；重启后再
      // 不匹配按原样报错，不无限回环。
      let restarted = false
      let accepted:
        | {
            url: string
            localPort: number
            remotePort: number
            pid: number
            forward: ForwardHandle
            instance: { dsh: string | null; plugin: string | null }
            drift: VersionDrift | null
            localDsh: string
          }
        | undefined
      for (;;) {
        const launched = await this.launchInstance(target, id, servicePaths)

        this.step(id, 'forward', `127.0.0.1 → 远端 :${launched.launch.remotePort}`)
        // 首选口 = 按 id 推导的固定槽位（preferredLocalTunnelPort）：跨重连 /
        // 宿主重启稳定，隧道 authority、书签与外部端口规则不失效。探测空闲才
        // 用，被占回退内核临时端口。
        const preferredPort = preferredLocalTunnelPort(id)
        let localPort = (await this.deps.probeLocalPort(preferredPort))
          ? preferredPort
          : await this.deps.freeLocalPort()
        // 转发进程是否已退出：ssh 绑不上本地口（ExitOnForwardFailure=yes）会
        // 立即退出，而本地 bind 发生在连上远端之后（时延随网络 / 认证浮动），
        // 不能用 spawn 后短窗口看存活——「健康检查不过且进程已死」才是「本地口
        // 没绑上」的确定性判据；进程活着但不通才是实例侧问题。
        let forwardDied = false
        let forward: ForwardHandle | null = null
        let url: string | undefined
        let healthy = false
        for (;;) {
          forward = await this.deps.startForward(target, localPort, launched.launch.remotePort)
          forwardDied = false
          runtime.forward = forward
          forward.onExit(() => {
            forwardDied = true
            const current = this.runtimeOf(id)
            // 进程已亡租约即失效，清掉免得下次清扫对着死 pid 空转
            void this.deps.forwards.clear(id)
            if (current.forward === forward && current.running !== null) {
              current.phase = 'error'
              current.error = { message: '本地端口转发中断：请重新连接（远端实例仍在运行）', kind: 'unknown' }
              current.running = null
              current.forward = null
            }
          })

          url = rewriteLaunchUrl(
            `http://127.0.0.1:${launched.launch.remotePort}/?token=${launched.launch.token}`,
            localPort,
          )
          if (url === undefined) throw new SshFailure('unknown', '就绪信号解析失败')

          this.step(id, 'health', `http://127.0.0.1:${localPort}/`)
          for (let attempt = 0; attempt < HEALTH_RETRY && !healthy && !forwardDied; attempt += 1) {
            await this.deps.delay(HEALTH_INTERVAL_MS)
            healthy = await this.deps.healthCheck(`http://127.0.0.1:${localPort}/`)
          }
          if (healthy || !forwardDied) break
          forward.kill()
          runtime.forward = null
          // 死在临时口 = 真实故障（内核挑的空闲口都绑不上，重启远端无益）；死在
          // 首选口 = 探测后的竞态占用，换临时端口重试一次。
          if (localPort !== preferredPort)
            throw new SshFailure(
              'unreachable',
              `本地端口转发建立失败（端口 ${localPort} 未能绑定）：请重试连接`,
            )
          this.step(id, 'forward', `首选端口 ${preferredPort} 被占，改用临时端口重试`)
          localPort = await this.deps.freeLocalPort()
        }
        // 走到这里只有两种形态：healthy = 隧道就绪；!healthy = 转发进程活着但
        // 不通（进程已死的形态已在循环内换口重试或报错）——实例侧问题交自愈 /
        // 报错。url / forward 的空值守卫实际不可达，只为收窄类型。
        if (!healthy || url === undefined || forward === null) {
          forward?.kill()
          runtime.forward = null
          // 复用实例健康检查不过 = 实例病了（旧就绪行还在、HTTP 不应答）——重启
          // 自愈一次；新启动的实例失败属于环境 / 转发问题，重启无益。
          if (restarted || !launched.reused)
            throw new SshFailure(
              'unreachable',
              '端口转发健康检查失败：本机未能经隧道取到任何 HTTP 响应（检查远端 sshd 的 AllowTcpForwarding 是否放行 -L）',
            )
          restarted = true
          this.step(id, 'restart', '复用实例无响应')
          await this.stopInstance(target, id)
          continue
        }

        this.step(id, 'version', '核验实例版本')
        const version = await this.deps.instanceVersion(url)
        let mismatch: string
        if (version.ok) {
          // dsh 相等或新于本机目标都接受：远端被用户单独升级后不降级也不误杀，
          // 漂移 local-behind 交面板提示本机升级。插件仍要求与本机一致——磁盘
          // 上是部署段刚对齐的版本，不一致说明旧进程还没加载到新代码。
          const relation = version.dsh === null ? null : compareDshVersion(version.dsh, targetVersion)
          const dshOk = relation !== null && relation >= 0
          const pluginOk =
            this.deps.localPluginVersion === null || version.plugin === this.deps.localPluginVersion
          if (dshOk && pluginOk) {
            accepted = {
              url,
              localPort,
              remotePort: launched.launch.remotePort,
              pid: launched.pid,
              forward,
              // 版本判定问到的那份自报身份直接种进 running：面板行先有东西可显，
              // 之后由心跳按 beat 实时刷新；漂移同拍种下（远端较新 = local-behind）
              instance: { dsh: version.dsh, plugin: version.plugin },
              drift: relation > 0 ? 'local-behind' : null,
              localDsh: targetVersion,
            }
            break
          }
          mismatch = `实例 dsh ${version.dsh ?? '?'} / 插件 ${version.plugin ?? '?'}，本机 dsh ${targetVersion} / 插件 ${this.deps.localPluginVersion ?? '?'}`
        } else if (version.http === 404) {
          mismatch = '实例运行着未带版本接口的旧插件'
        } else {
          forward.kill()
          runtime.forward = null
          // 认证 / 服务端错误重启解决不了：显式失败带原因，不盲目回环
          throw new SshFailure(
            'unknown',
            `无法确认远端实例版本：${version.error ?? `版本接口 HTTP ${String(version.http)}`}`,
          )
        }
        forward.kill()
        runtime.forward = null
        if (restarted) throw new SshFailure('unknown', `远端实例重启后版本仍不匹配（${mismatch}）`)
        restarted = true
        this.step(id, 'restart', '版本不匹配，重启远端实例')
        await this.stopInstance(target, id)
      }

      runtime.running = {
        url: accepted.url,
        localPort: accepted.localPort,
        remotePort: accepted.remotePort,
        pid: accepted.pid,
        since: this.deps.now(),
        machine,
        instance: accepted.instance,
        drift: accepted.drift,
        localDsh: accepted.localDsh,
        // 新连接（含自动收敛后的新连接）从「未探测」开始，第一次心跳在 10s 后
        health: null,
      }
      runtime.health.checkedAt = this.nowMs()
      runtime.health.failures = 0
      runtime.health.pausedUntil = 0
      // 转发进程与内存句柄可能同时幸存于宿主重启——租约落盘供下次 load 清扫
      if (accepted.forward.pid !== null) {
        await this.deps.forwards.record(id, {
          pid: accepted.forward.pid,
          localPort: accepted.localPort,
          remotePort: accepted.remotePort,
          at: this.deps.now(),
        })
      }
      this.settle(id, 'running')
    } catch (error) {
      this.fail(id, error)
    }
  }

  /** 启动段：systemd 用户单元幂等落盘（内容不变不重写、变了经 restart 生效）
   *  + enable-linger（开机自启的前提）+ start（unit 已 active 且未变更即复用
   *  候选）+ poll 就绪行。远端缺 systemctl / 用户总线 / linger 任一环显式报错
   *  ——不回退 nohup。复用候选是否被接受由调用方在版本判定后决定（不匹配则
   *  杀旧重来，见 runConnect）。 */
  private async launchInstance(
    target: SshTarget,
    id: string,
    paths: ServicePaths,
  ): Promise<{ launch: RemoteLaunch; pid: number; reused: boolean }> {
    const pidFile = pidFileOf(id)
    this.step(id, 'start', UNIT_NAME)
    // 单元内容经 stdin 落盘（与同一连接的其余逻辑合并，一次建连完成全部启动
    // 步骤）；探测 / linger / 总线的失败以标记行分类，逐类给出可操作的指引。
    const start = await this.deps.exec(target, buildLaunchCommand(pidFile), {
      stdin: buildUnitContent(paths),
      timeoutMs: 60_000,
    })
    // 标记分类先于退出码判定：__STARTFAIL__ 分支以非零码收场，通用检查在前
    // 会吞掉带 status 尾部的具体原因
    const markers = markedValues(start.stdout)
    if (start.code !== 0 && !markers.has('STARTFAIL'))
      throw new SshFailure(
        'remote-cmd-failed',
        `远端实例启动失败：${start.stderr.trim()}`,
        mergedOutput(start.stdout, start.stderr),
      )
    if (markers.has('NOSYSTEMD'))
      throw new SshFailure(
        'remote-cmd-failed',
        '远端没有可用的 systemctl / loginctl：远端实例现由 systemd 用户服务托管（开机自启、崩溃自动重启），要求远端为启用 systemd 的 Linux 发行版（systemd ≥ 240）。macOS 或无 systemd 的环境不受支持',
        mergedOutput(start.stdout, start.stderr),
      )
    if (markers.has('LINGERFAIL'))
      throw new SshFailure(
        'remote-cmd-failed',
        `远端无法启用 loginctl enable-linger（实例要在 ssh 退出后常驻、开机自启全靠它）：${markers.get('LINGERFAIL') || '原因未知'}。请确认远端 polkit 允许自启用 linger，或由管理员执行 loginctl enable-linger 后重试`,
        mergedOutput(start.stdout, start.stderr),
      )
    if (markers.has('NOBUS'))
      throw new SshFailure(
        'remote-cmd-failed',
        `无法连接 systemd 用户总线（systemctl --user）：${markers.get('NOBUS') || '原因未知'}。确认远端用户管理器在运行（/run/user/$(id -u) 存在）后重试`,
        mergedOutput(start.stdout, start.stderr),
      )
    if (markers.has('STARTFAIL'))
      throw new SshFailure(
        'remote-cmd-failed',
        `systemd 启动远端实例失败：${summarizeOutput(markers.get('STARTFAIL') ?? '', start.stderr)}（可查看 journalctl --user -u ${UNIT_NAME} 与远端日志 ${UNIT_LOG}）`,
        mergedOutput(start.stdout, start.stderr),
      )
    const reused = start.stdout.includes('reuse:')

    this.step(id, 'poll', '等待就绪信号')
    // 轮询整体在远端有界循环：一次建连等到就绪或窗口耗尽（Windows 无连接复
    //  用，拆成每 2s 一条 grep 意味着上百次建连）。本地兜底超时 = 循环上限 +
    // 建连余量；就算本地提前断开，远端循环有界自灭不泄漏进程。pid 附带在同
    // 一条连接的输出里（systemd MainPID）。
    const maxAttempts = Math.ceil(CONNECT_POLL_LIMIT_MS / CONNECT_POLL_INTERVAL_MS)
    const poll = await this.deps.exec(
      target,
      buildPollCommand(maxAttempts, CONNECT_POLL_INTERVAL_MS / 1000),
      { timeoutMs: CONNECT_POLL_LIMIT_MS + 60_000 },
    )
    const launch = poll.code === 0 ? parseLaunchFromLog(poll.stdout) : undefined
    if (launch === undefined) {
      const tail = await this.deps.exec(target, `tail -n 20 ${UNIT_LOG} || true`)
      const text = tail.stdout.trim()
      // 端口在探测之后被占：显式指出端口与出路，不让人对着通用超时猜
      const occupied = text.includes('EADDRINUSE')
      throw new SshFailure(
        'timeout',
        occupied
          ? `远端实例未能在端口 ${paths.port} 上启动（日志显示 EADDRINUSE：该端口在探测之后被别的进程占用）。请释放该端口，或删除远端单元 ~/.config/systemd/user/${UNIT_NAME} 后重连以重新选端口。日志尾部：\n${text.slice(-800)}`
          : `远端实例 ${CONNECT_POLL_LIMIT_MS / 1000}s 内未输出就绪信号。日志尾部：\n${text.slice(-800)}`,
        mergedOutput(tail.stdout, tail.stderr),
      )
    }
    // 端口以实例实际打印的为准（隧道必须指向真实监听口）；与单元不一致说明
    // 远端 dsh 没有按 `--port` 起，记一笔便于排查——不在连接路径上失败。
    if (launch.remotePort !== paths.port) {
      this.step(id, 'port-drift', `单元 --port ${paths.port}，实例实际监听 ${launch.remotePort}`)
    }
    const pid = Number.parseInt(markedValues(poll.stdout).get('PID') ?? '', 10)
    return { launch, pid: Number.isInteger(pid) ? pid : 0, reused }
  }

  /** 停止远端实例（版本不匹配 / 复用实例无响应时的收敛动作）：systemd 按单元
   *  停整组进程（cgroup 语义连 MCP server 一起收，无 pid 身份核验与补杀的
   *  必要），随后清旧 pid 文件、截断日志——旧就绪行不清掉，下次 poll 秒命中
   *  死实例的旧 token。单元保持 enabled：重启收敛与开机自启不受影响。 */
  private async stopInstance(target: SshTarget, id: string): Promise<void> {
    const stop = await this.deps.exec(target, buildStopCommand(pidFileOf(id)), {
      timeoutMs: 60_000,
    })
    if (stop.code !== 0 || markedValues(stop.stdout).has('STOPFAIL'))
      throw new SshFailure(
        'remote-cmd-failed',
        // 摘要走横幅剔除：本机 ssh 客户端对远端 sshd 打 post-quantum 警告污染 stderr
        `远端实例停止失败：${summarizeOutput(stop.stdout, stop.stderr)}`,
        mergedOutput(stop.stdout, stop.stderr),
      )
  }

  /** 宿主卸载插件（含退出）时杀掉全部本地转发；远端实例不动（常驻远端由用户
   *  自理，下次连接按 systemd 单元复用秒连）。租约清空是尽力而为（进程退出不
   *  等异步写完成），漏掉的由下次 load 的清扫兜底（死 pid 直接清记录）。 */
  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.forward?.kill()
      runtime.forward = null
    }
    void this.deps.forwards.clearAll()
  }

  /**
   * 存活心跳（面板轮询驱动，见 host 的 GET /state）：只探 running 连接，同一
   * 连接不并发，10s 一次。每拍就是「测试链接」的完整查询——全部走**既有本地
   * 转发**、不开新 ssh：GET /（任何 HTTP 响应含 401 即算活着）+ GET /version
   * （实例自报身份，面板行上的 dsh / 插件版本实时刷新）。只有连续 3 次探测
   * 失败（≈30s）才建一条 ssh 向 systemd 核实，避免宿主休眠 / systemd 重启窗口
   * 被误判成「死了」。
   *
   * 为什么需要它：running 只是连接成功那一刻的内存事实。远端 dsh 被 systemctl
   * stop、崩溃循环触顶、或机器重启后 linger 没生效时，sshd 只会拒绝新建隧道通道，
   * 本地 `-L` 监听照旧存在——没有心跳，面板会一直显示「运行中」。
   */
  heartbeat(): Promise<void> {
    const now = this.nowMs()
    const probes: Promise<void>[] = []
    for (const [id, runtime] of this.runtimes) {
      if (runtime.running === null || runtime.op !== null) continue
      const health = runtime.health
      if (health.probing || now < health.pausedUntil) continue
      if (Number.isFinite(health.checkedAt) && now - health.checkedAt < HEARTBEAT_INTERVAL_MS) continue
      health.checkedAt = now
      health.probing = true
      // 探测自身的意外异常不外抛（/state 是 fire-and-forget 调用点）：状态留在
      // 「未探测」，下一轮心跳自然会再试
      probes.push(this.probeLiveness(id).catch(() => {}))
    }
    return Promise.all(probes).then(() => undefined)
  }

  /** deps.now() 的毫秒形式（ISO 字符串；解析不了回退本机时钟）。 */
  private nowMs(): number {
    const parsed = Date.parse(this.deps.now())
    return Number.isFinite(parsed) ? parsed : Date.now()
  }

  private async probeLiveness(id: string): Promise<void> {
    try {
      const runtime = this.runtimes.get(id)
      if (runtime === undefined || runtime.running === null) return
      const url = runtime.running.url
      let healthy = false
      try {
        healthy = await this.deps.healthCheck(url)
      } catch {
        healthy = false
      }
      const current = this.runtimes.get(id)
      if (current === undefined) return
      if (healthy) {
        current.health.failures = 0
        current.health.okStreak += 1
        // 连续健康两轮才认为「这轮掉线过去了」，清零收敛计数——否则「起来就崩」
        // 的实例会让自动恢复无限重连
        if (current.health.okStreak >= RECOVERY_RESET_STREAK) current.health.recoveries = 0
        this.setHealth(current, null)
        // 心跳即「测试链接」的完整查询：隧道活着之外，顺路问实例自报身份
        // （token 换 Cookie 后 GET /version），面板行上的 dsh / 插件版本由此实时
        // 刷新。问不到（token 过期等）保留上次自报，不当作异常。版本漂移同拍
        // 重算：基准是本机现读版本（本机升级 / 远端被单独改动都能在此显形），
        // 问不到本机版本时漂移清空（无法判定不驱动动作）。
        const version = await this.deps.instanceVersion(url)
        const live = this.runtimes.get(id)
        if (live !== undefined && live.running !== null && live.running.url === url && version.ok) {
          const localDsh = await this.deps.currentDshVersion()
          const fresh = this.runtimes.get(id)
          if (
            fresh !== undefined &&
            fresh.running !== null &&
            fresh.running.url === url &&
            fresh.op === null
          ) {
            fresh.running = {
              ...fresh.running,
              instance: { dsh: version.dsh, plugin: version.plugin },
              drift: dshDrift(localDsh, version.dsh),
              localDsh,
            }
          }
        }
        return
      }
      current.health.okStreak = 0
      current.health.failures += 1
      if (current.health.failures < HEARTBEAT_FAILURE_LIMIT) return
      current.health.failures = 0
      if (current.op !== null) return
      await this.classifyLiveness(id)
    } finally {
      const current = this.runtimes.get(id)
      if (current !== undefined) current.health.probing = false
    }
  }

  /** 探测判死后的核实与处置：systemd 说「正在拉起」就再等一等；说「活着」就
   *  报无响应（进程卡死，重启会丢现场）；说「inactive / failed」才自动收敛。
   *  读不到状态（ssh 不通、systemctl 缺失、输出畸形）一律按无法核实降级——
   *  绝不在没有事实时重启别人的实例。 */
  private async classifyLiveness(id: string): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (runtime === undefined || runtime.running === null) return
    let connection: StoredConnection
    try {
      connection = this.connectionOf(id)
    } catch {
      return
    }
    const now = this.nowMs()
    const pause = (health: RunningHealth, ms: number): void => {
      this.setHealth(runtime, health)
      runtime.health.pausedUntil = now + ms
    }
    // 密码登录且会话口令已丢（宿主重启过）：没有可用于 ssh 的口令，无法核实
    if (targetRequiresSecret(connection.target) && this.secretOf(connection) === null) {
      pause({ state: 'unknown', at: this.deps.now() }, HEALTH_PAUSE_MS)
      return
    }
    let facts: LivenessFacts
    try {
      const verdict = await this.deps.exec(this.sshTargetOf(connection), buildHealthCommand(), {
        timeoutMs: 30_000,
      })
      facts = parseLivenessFacts(verdict.stdout)
    } catch (error) {
      // ssh 本身不可达：实例可能完好（宿主休眠 / 网络断了），隧道恢复后还能用
      pause({ state: 'unknown', at: this.deps.now(), detail: errMsg(error) }, HEALTH_PAUSE_MS)
      return
    }
    const summary = `systemd：${facts.active ?? '未知'}${facts.sub === null ? '' : `/${facts.sub}`}${
      facts.restarts === null ? '' : `（NRestarts=${facts.restarts}）`
    }`
    const detail = [summary, facts.log].filter((line) => line.length > 0).join('\n')
    if (facts.active === 'active') {
      pause({ state: 'unresponsive', at: this.deps.now(), detail }, HEALTH_PAUSE_MS)
      return
    }
    if (facts.active === 'activating' || facts.active === 'reloading' || facts.active === 'deactivating') {
      pause({ state: 'restarting', at: this.deps.now(), detail }, HEARTBEAT_INTERVAL_MS)
      return
    }
    if (facts.active === 'inactive' || facts.active === 'failed') {
      await this.recover(id, connection, facts, detail)
      return
    }
    pause({ state: 'unknown', at: this.deps.now(), detail }, HEALTH_PAUSE_MS)
  }

  /** 自动收敛：复用正常连接流程把实例拉起来（unit 已 enabled，restart 由启动段
   *  的 systemctl 语义完成），成功后回 running 并让面板看到一次「已自动恢复」。
   *  同一轮掉线最多 RECOVERY_LIMIT 次，超了判死停手——不把重连变成风暴。 */
  private async recover(
    id: string,
    connection: StoredConnection,
    facts: LivenessFacts,
    detail: string,
  ): Promise<void> {
    const runtime = this.runtimeOf(id)
    if (runtime.running === null || runtime.op !== null) return
    if (runtime.health.recoveries >= RECOVERY_LIMIT) {
      this.declareDown(id, runtime, facts, detail)
      return
    }
    runtime.health.recoveries += 1
    runtime.op = { kind: 'recover' }
    runtime.progress = { kind: 'recover', steps: [] }
    runtime.phase = 'deploying'
    this.step(id, 'recover', `systemd ${facts.active ?? '未知'}`)
    await this.runConnect(connection)
  }

  /** 判死：隧道已无用，杀掉转发、清租约、进入 error，并把 systemd 侧的事实留在
   *  错误详情里（面板「查看完整」）。之后只能由用户重新连接。 */
  private declareDown(id: string, runtime: ConnRuntime, facts: LivenessFacts, detail: string): void {
    runtime.forward?.kill()
    runtime.forward = null
    runtime.running = null
    runtime.op = null
    runtime.phase = 'error'
    runtime.progress = { kind: 'recover', steps: [] }
    runtime.error = {
      kind: 'unknown',
      message: `远端实例已停止（systemd：${facts.active ?? '未知'}${facts.sub === null ? '' : `/${facts.sub}`}），自动恢复 ${RECOVERY_LIMIT} 次仍未恢复：请重新连接`,
      detail,
    }
    void this.deps.forwards.clear(id)
  }

  /** 写入 / 清除心跳结论（running 被重建即视为旧结论作废）。 */
  private setHealth(runtime: ConnRuntime, health: RunningHealth | null): void {
    if (runtime.running === null) return
    if (health === null && runtime.running.health === null) return
    runtime.running = { ...runtime.running, health }
  }

  /** 远端一个 skills 根的技能内容指纹：find|sha256 管线一次取整根文件摘要，
   *  host 侧按顶层段折成 name → digest（与 localenv.foldSkillDigest 同一折叠）。
   *  hasher 缺失 / 命令失败回 null——该根全部按「无法比对」保守推送。
   *  刻意不比 mtime / mode：声明语义只关心内容字节。 */
  private async remoteSkillFacts(
    target: SshTarget,
    key: 'user-dsh' | 'user-agents',
  ): Promise<RemoteSkillFact[] | null> {
    const root = key === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills'
    const list = await this.deps.exec(
      target,
      `if cd ${root} 2>/dev/null; then if command -v sha256sum >/dev/null 2>&1; then find . -type f ! -path '*/.*' -print0 | xargs -0 sha256sum; elif command -v shasum >/dev/null 2>&1; then find . -type f ! -path '*/.*' -print0 | xargs -0 shasum -a 256; else echo __DSH_NO_HASHER__; fi; fi`,
    )
    if (list.code !== 0 || list.stdout.includes('__DSH_NO_HASHER__')) return null
    const byName = new Map<string, { path: string; hash: string }[]>()
    for (const line of list.stdout.split(/\r?\n/)) {
      // sha256sum / shasum 输出形态：`<hash>  ./path`（二进制模式为 ` *./path`）
      const match = /^([0-9a-f]{64})[ *]+(.+)$/.exec(line)
      if (match === null) continue
      const path = match[2].replace(/^\.\//, '')
      const slash = path.indexOf('/')
      const top = slash === -1 ? path : path.slice(0, slash)
      const name = top.endsWith('.md') ? top.slice(0, -'.md'.length) : top
      if (name.length === 0) continue
      const files = byName.get(name) ?? []
      files.push({ path, hash: match[1] })
      byName.set(name, files)
    }
    return [...byName].map(([name, files]) => ({ name, digest: foldSkillDigest(files) }))
  }

  /** 远端插件事实：bundles 激活清单 + 激活插件的已装版本（一条 node 批量读，
   *  部署前置保证远端有 node；脚本见 REMOTE_PLUGIN_FACTS_SCRIPT）。任一环节
   *  失败回 null——按「无法比对」处理，同步侧保守安装。 */
  private async remotePluginFacts(
    target: SshTarget,
    names: readonly string[],
  ): Promise<RemotePluginFact[] | null> {
    const pkg = `~/.dsh/profiles/${REMOTE_PROFILE}/package.json`
    const current = await this.deps.exec(target, `cat ${pkg} 2>/dev/null || true`)
    let bundles: string[]
    try {
      const parsed = JSON.parse(current.stdout) as { dsh?: { profile?: { bundles?: unknown } } }
      const raw = parsed.dsh?.profile?.bundles
      bundles = Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : []
    } catch {
      return null
    }
    const facts = new Map<string, string | null>()
    const probe = bundles.filter((name) => names.includes(name))
    if (probe.length > 0) {
      const read = await this.deps.exec(
        target,
        `cd ~/.dsh/profiles/${REMOTE_PROFILE}/node_modules && node -e ${shQuote(
          REMOTE_PLUGIN_FACTS_SCRIPT,
        )} ${probe.map((name) => shQuote(name)).join(' ')}`,
        { timeoutMs: 60_000 },
      )
      if (read.code !== 0) return null
      for (const line of read.stdout.split(/\r?\n/)) {
        // 输出行形态：`<name>\t<version>`（version 空串 = 读不到）
        const first = line.indexOf('\t')
        if (first <= 0) continue
        const version = line.slice(first + 1).trim()
        facts.set(line.slice(0, first), version.length > 0 ? version : null)
      }
    }
    return bundles.map((name) => ({ name, version: facts.get(name) ?? null }))
  }

  /** 远端系统提示词事实：单文件 sha256（sha256sum / shasum 择一，文件缺失打
   *  __ABSENT__ 哨兵、hasher 缺失打 __NO_HASHER__）。命令失败回 null——按
   *  「无法比对」处理，同步侧保守推送。仅需 ssh 可达（同 skills / MCP）。 */
  private async remotePromptFact(target: SshTarget): Promise<RemotePromptFact | null> {
    const file = '~/.dsh/system-prompt.md'
    const out = await this.deps.exec(
      target,
      `f=${file}; if [ ! -f "$f" ]; then echo __ABSENT__; elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$f"; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$f"; else echo __NO_HASHER__; fi`,
    )
    if (out.code !== 0) return null
    const text = out.stdout.trim()
    if (text === '__NO_HASHER__') return null
    if (text === '__ABSENT__') return { exists: false, digest: null }
    const hash = /^([0-9a-f]{64})\b/.exec(text)
    return hash === null ? null : { exists: true, digest: hash[1] }
  }

  /** POST /remote-inventory：同步弹窗的徽标判定源（远端四类条目的事实）。
   *  读侧任一环节失败按该类 null 降级——弹窗按「无法比对」渲染但不阻断同步
   *  （只有新增/覆盖，无删除风险）；ssh 连接级失败仍抛（路由转 5xx，弹窗提示）。 */
  async remoteInventory(id: string): Promise<RemoteInventoryResponse> {
    await this.load()
    const connection = this.connectionOf(id)
    this.ensureSecret(connection)
    const target = this.sshTargetOf(connection)
    const skills = {
      'user-dsh': await this.remoteSkillFacts(target, 'user-dsh'),
      'user-agents': await this.remoteSkillFacts(target, 'user-agents'),
    }
    const mcpFileText = await this.deps.exec(target, 'cat ~/.dsh/mcp.json 2>/dev/null || true')
    let mcp: RemoteMcpFact[] | null = []
    if (mcpFileText.stdout.trim().length > 0) {
      try {
        const { entries } = parseMcpServers(mcpFileText.stdout)
        mcp = [...entries].map(([name, entry]) => ({
          name,
          signature: mcpSignature(entry),
          summary: mcpSummary(entry),
        }))
      } catch {
        // 远端文件结构坏：无法比对（写入侧 doMcpSync 会显式失败并报原因）
        mcp = null
      }
    }
    const { pluginRows } = await composeLocalRows(await this.deps.readLocalLayers())
    const plugins = await this.remotePluginFacts(
      target,
      pluginRows.map((row) => row.name),
    )
    const prompts = await this.remotePromptFact(target)
    return { skills, mcp, plugins, prompts }
  }

  /** 触发同步：names 为勾选项（提交即执行——勾选项全量安装/覆盖；
   *  未勾选 = 不动——同步只往远端新增/覆盖，永不删除远端内容）。 */
  startSync(
    id: string,
    kind: SyncKind,
    names: readonly string[],
    registryInstall: RegistryPluginInstall = 'remote',
  ): void {
    const restPhase = this.runtimeOf(id).running !== null ? 'running' : 'idle'
    const kindOfOp =
      kind === 'skills'
        ? 'sync-skills'
        : kind === 'mcp'
          ? 'sync-mcp'
          : kind === 'plugins'
            ? 'sync-plugins'
            : 'sync-prompts'
    this.beginOp(id, { kind: kindOfOp }, restPhase)
    this.step(id, kind === 'skills' ? 'scan' : 'read-local')
    const selected = new Set(names)
    void (async () => {
      const runtime = this.runtimeOf(id)
      try {
        if (kind === 'skills') await this.doSkillsSync(id, selected)
        else if (kind === 'mcp') await this.doMcpSync(id, selected)
        else if (kind === 'plugins') await this.doPluginSync(id, selected, registryInstall)
        else await this.doPromptSync(id, selected)
        this.settle(id, this.restPhase(runtime))
      } catch (error) {
        this.fail(id, error)
      }
    })()
  }

  /** Skills 同步：提交即执行——勾选项按根打包推送（弹窗判定是事实源，勾选
   *  已一致项即强制重推）；未勾选不动——同步只往远端新增/覆盖，不删除远端
   *  内容。 */
  private async doSkillsSync(id: string, selected: ReadonlySet<string>): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const next: Record<string, string[]> = {}
    let pushed = 0
    for (const root of await this.deps.scanSkills()) {
      const remoteRoot = root.key === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills'
      const chosen = root.rows.filter((row) => selected.has(row.name)).map((row) => row.name)
      next[root.key] = chosen
      if (chosen.length > 0) {
        this.step(id, 'push', `${root.key} ${chosen.length} 项`)
        await this.deps.pushTar(this.sshTargetOf(connection), root.path, remoteRoot, chosen)
        pushed += chosen.length
      }
    }
    this.store.manifest[id] = { ...this.manifestOf(id), skills: next }
    await this.persist()
    runtime.lastSync.skills = { at: this.deps.now(), pushed }
  }

  /** MCP 同步：提交即执行——本机全局 mcp.json 的选中条目合并进远端同一文件
   *  （Map 原位覆盖保键序，远端独有条目与顶层其他键不动——只新增/覆盖，
   *  永不删除；勾选已一致条目即强制重写，写入幂等）。工作区档是目录特定，
   *  不参与跨机同步。远端文件解析不了（结构坏）时显式中止：盲覆盖会毁掉
   *  用户手写的其余条目。 */
  private async doMcpSync(id: string, selected: ReadonlySet<string>): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const local = await this.deps.readLocalMcp()
    const chosen = [...local.entries].filter(([name]) => selected.has(name))
    const installed = chosen.map(([name]) => name)

    if (chosen.length > 0) {
      const remoteFile = '~/.dsh/mcp.json'
      this.step(id, 'read-remote', remoteFile)
      const current = await this.deps.exec(
        this.sshTargetOf(connection),
        `cat ${remoteFile} 2>/dev/null || true`,
      )
      let remote: { rootExtras: Record<string, unknown>; entries: Map<string, Record<string, unknown>> }
      try {
        remote = parseMcpServers(current.stdout.trim().length === 0 ? null : current.stdout)
      } catch (error) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端 ${remoteFile} 解析失败，中止覆盖：${error instanceof Error ? error.message : String(error)}`,
          mergedOutput('', current.stdout),
        )
      }

      this.step(id, 'merge', `${chosen.length} 条`)
      for (const [name, entry] of chosen) remote.entries.set(name, entry)
      const next = { ...remote.rootExtras, mcpServers: Object.fromEntries(remote.entries) }

      this.step(id, 'write-remote')
      const write = await this.deps.exec(
        this.sshTargetOf(connection),
        `cat > ${remoteFile}.tmp-dsh-remote && mv ${remoteFile}.tmp-dsh-remote ${remoteFile}`,
        { stdin: `${JSON.stringify(next, null, 2)}\n` },
      )
      if (write.code !== 0)
        throw new SshFailure(
          'remote-cmd-failed',
          `远端 mcp.json 写入失败：${write.stderr.trim()}`,
          mergedOutput('', write.stderr),
        )
    }

    this.store.manifest[id] = { ...this.manifestOf(id), mcp: installed }
    await this.persist()
    runtime.lastSync.mcp = { at: this.deps.now(), installed }
  }

  /** 插件同步：提交即安装（弹窗判定是事实源，勾选已一致项即强制重推）——
   *  同版本换内容由 payload 文件名的内容盐区分 specifier，hoisted linker 会
   *  真正重新解包。未勾选不动（不删除）。registry 插件按调用选项分流推送 /
   *  远端 npm 下载；本地路径安装恒本地打包传输（未发布的开发版本也只有这条
   *  路径能到达远端）。 */
  private async doPluginSync(
    id: string,
    selectedIn: ReadonlySet<string>,
    registryInstall: RegistryPluginInstall,
  ): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const { pluginRows } = await composeLocalRows(await this.deps.readLocalLayers())
    const byName = new Map(pluginRows.map((row) => [row.name, row]))
    const selected = [...selectedIn].filter((name) => !isRemoteSelf(name) && byName.has(name))

    const installed: string[] = []
    for (const name of selected) {
      const row = byName.get(name)
      if (row === undefined) continue
      this.step(id, 'install', row.name)
      const viaPush = row.install === 'local' || registryInstall === 'push'
      const install = viaPush
        ? await this.addViaPush(this.sshTargetOf(connection), row)
        : await this.deps.exec(
            this.sshTargetOf(connection),
            `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add ${shQuote(row.version === null ? row.name : `${row.name}@${row.version}`)}`,
            { timeoutMs: OP_TIMEOUT_MS },
          )
      if (install.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端安装 ${row.name} 失败：${summarizeOutput(install.stdout, install.stderr)}`,
          mergedOutput(install.stdout, install.stderr),
        )
      }
      installed.push(row.name)
    }

    this.store.manifest[id] = { ...this.manifestOf(id), plugins: selected }
    await this.persist()
    runtime.lastSync.plugins = { at: this.deps.now(), installed }
  }

  /** 提示词同步：提交即推送（tmp+mv 原子落盘远端 system-prompt.md）；未勾选不动。
   *  远端实例在下一次尚未开始的模型步骤读取新内容（远端装了 dsh-prompts 时生效）。 */
  private async doPromptSync(id: string, selected: ReadonlySet<string>): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const content = await this.deps.readSystemPrompt()
    if (content === null) {
      throw new SshFailure('unknown', '本机没有系统提示词文件（system-prompt.md），无可同步')
    }
    let pushed = false
    if (selected.size > 0) {
      const target = '~/.dsh/system-prompt.md'
      this.step(id, 'push', 'system-prompt.md')
      const write = await this.deps.exec(
        this.sshTargetOf(connection),
        `mkdir -p ~/.dsh && cat > ${target}.tmp-dsh-remote && mv ${target}.tmp-dsh-remote ${target}`,
        { stdin: content },
      )
      if (write.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端提示词写入失败：${write.stderr.trim()}`,
          mergedOutput('', write.stderr),
        )
      }
      pushed = true
    }
    this.store.manifest[id] = { ...this.manifestOf(id), prompts: pushed }
    await this.persist()
    runtime.lastSync.prompts = { at: this.deps.now(), pushed }
  }

  /** 打包本机包根 → 推送 payload → 远端 add tgz → 清同包其他版本的 payload
   *  文件（本地路径插件与选项 push 的 registry 插件共用；payload 只是传输介质，
   *  装入 node_modules 后即可清，目录不随版本迭代堆积）。 */
  private async addViaPush(
    target: SshTarget,
    row: { name: string; root: string | null },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (row.root === null) {
      throw new SshFailure('unknown', `本机未能定位 ${row.name} 的包目录，无法本地传输；请检查其安装后重试`)
    }
    const packed = await this.deps.packPackage(row.root)
    await this.deps.pushFile(target, packed.path, '~/.dsh/dsh-remote/payload', packed.fileName)
    const install = await this.deps.exec(
      target,
      `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add "$HOME/.dsh/dsh-remote/payload/${packed.fileName}"`,
      { timeoutMs: OP_TIMEOUT_MS },
    )
    if (install.code === 0) {
      // 当前文件必须保留：package.json 的 file: spec 持续指向它，pnpm 后续任何
      // add/install 都会重读全部 file: 依赖——只清同包其他版本（装完即无人引用）。
      // 版本段锚定数字：@weilence/dsh-mcp 不误删 @weilence/dsh-mcp-x 的文件。
      const flat = row.name.replace(/^@/, '').replace(/\//g, '-')
      await this.deps.exec(
        target,
        `find ~/.dsh/dsh-remote/payload -maxdepth 1 -name '${flat}-[0-9]*.tgz' ! -name '${packed.fileName}' -delete || true`,
      )
    }
    return install
  }
}
