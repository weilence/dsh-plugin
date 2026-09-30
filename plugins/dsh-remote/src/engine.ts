import type { ForwardHandle, SshExec } from './ssh'
import { SshFailure, shQuote } from './ssh'
import type { ForwardRegistry } from './forwards'
import { createHash } from 'node:crypto'
import { errMsg } from '@dsh-plugins/shared'
import { parseLaunchFromLog, rewriteLaunchUrl, type RemoteLaunch } from './launch'
import { normalizeConnection, readStore, writeStore, type SyncManifest, type StoreFile } from './connections'
import {
  PACKAGE_PACK_EXCLUDED,
  composeLocalRows,
  foldMcpRows,
  foldSkillDigest,
  mcpSummary,
  type LocalPatchLayer,
} from './localenv'
import {
  emptyPatchDoc,
  parsePatchDoc,
  removeInsertRows,
  renderPatchDoc,
  scanInserts,
  upsertInsertRow,
} from './patchDoc'
import {
  MCP_PLUGIN_NAME,
  REMOTE_PLUGIN_NAME,
  REMOTE_PROFILE,
  isRemoteSelf,
  mcpSignature,
  pluginStatus,
  promptStatus,
  skillStatus,
  type ConnOp,
  type ConnRow,
  type ConnState,
  type RegistryPluginInstall,
  type RemoteConnection,
  type RemoteInventoryResponse,
  type RemoteMcpFact,
  type RemotePluginFact,
  type RemotePromptFact,
  type RemoteSkillFact,
  type SaveRequest,
  type SshErrorKind,
  type SyncKind,
  type TestResponse,
} from './shared'

/** MCP 行 config 的 serverName（非字符串或缺省为 undefined）。 */
function asServerName(config: unknown): string | undefined {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return undefined
  const name = (config as Record<string, unknown>).serverName
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

/** 远端读插件事实的内嵌脚本（remotePluginFacts 经 ssh 执行）：输出行
 *  `<name>\t<version>\t<digest>`。指纹的收集与折叠镜像 localenv.packageTreeDigest
 *  （'/' 相对路径、isPackJunkSegment 同一忽略规则、符号链接不计、path\0hash\0
 *  排序折叠）——导出供测试以真实子进程校验镜像不变量。 */
export const REMOTE_PLUGIN_FACTS_SCRIPT = [
  'const fs = require("fs"), crypto = require("crypto")',
  `const excluded = new Set(${JSON.stringify(PACKAGE_PACK_EXCLUDED)})`,
  // ._ 前缀条目与排除段同样不计：镜像 localenv.isPackJunkSegment
  'const junk = (name) => excluded.has(name) || name.startsWith("._")',
  'function walk(dir, prefix, out) {',
  '  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {',
  '    if (junk(e.name)) continue',
  '    const rel = prefix + e.name',
  '    if (e.isDirectory()) walk(dir + "/" + e.name, rel + "/", out)',
  '    else if (e.isFile()) out.push({ p: rel, h: crypto.createHash("sha256").update(fs.readFileSync(dir + "/" + e.name)).digest("hex") })',
  '  }',
  '}',
  'for (const n of process.argv.slice(1)) {',
  '  let v = "", d = ""',
  '  try { v = String(JSON.parse(fs.readFileSync(n + "/package.json", "utf8")).version ?? "") } catch {}',
  '  try {',
  '    const files = []',
  '    walk(fs.realpathSync(n), "", files)',
  '    files.sort((a, b) => (a.p < b.p ? -1 : 1))',
  '    d = crypto.createHash("sha256").update(files.map((f) => f.p + "\\0" + f.h + "\\0").join("")).digest("hex")',
  '  } catch {}',
  '  console.log(n + "\\t" + v + "\\t" + d)',
  '}',
].join('\n')

/** 本机 ssh 客户端的横幅行（如 OpenSSH 10 对无 post-quantum KEX 服务端的提示，
 *  首尾皆 **）：混在 stderr 里但不是远端命令的输出——报错时剔除，避免顶掉真实原因。 */
const SSH_CLIENT_BANNER = /^\*\*.*\*\*$/

/** 安装失败的详情行：两路输出合并、去空行与横幅噪声，取末几行。pnpm 的真实
 *  错误常打在 stdout（[ENOENT] 等不打 stderr），只看 stderr 会拿到空泛尾行。 */
function installFailureDetail(stdout: string, stderr: string): string {
  const lines = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SSH_CLIENT_BANNER.test(line))
  return lines.slice(-3).join(' ').slice(0, 300)
}

/** 引擎的外部效应面（测试注入 fake 用；生产接线见 host index.ts）。 */
export interface EngineDeps {
  exec: SshExec
  startForward(alias: string, localPort: number, remotePort: number): ForwardHandle
  freeLocalPort(): Promise<number>
  healthCheck(url: string): Promise<boolean>
  pushTar(alias: string, localRoot: string, remoteRoot: string, names?: readonly string[]): Promise<void>
  /** 单文件二进制推送（tgz 落盘远端 payload 目录）。 */
  pushFile(alias: string, localPath: string, remoteDir: string, fileName: string): Promise<void>
  readLocalLayers(): Promise<LocalPatchLayer[]>
  scanSkills(): Promise<
    { key: 'user-dsh' | 'user-agents'; path: string; rows: { name: string; digest: string | null }[] }[]
  >
  /** 本机全局提示词（AGENTS.md）原文；文件不存在为 null。 */
  readGlobalPrompt(): Promise<string | null>
  /** 本机 dsh 运行时版本（部署对齐目标）；解析失败为 null = 连接部署段直接失败（禁止回退安装 latest）。 */
  localDshVersion: string | null
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

interface ConnRuntime {
  phase: ConnState['phase']
  op: ConnOp | null
  error: { message: string; kind: SshErrorKind } | null
  running: ConnState['running']
  lastSync: ConnState['lastSync']
  forward: ForwardHandle | null
}

function freshRuntime(): ConnRuntime {
  return {
    phase: 'idle',
    op: null,
    error: null,
    running: null,
    lastSync: { skills: null, mcp: null, plugins: null, prompts: null },
    forward: null,
  }
}

const CONNECT_POLL_INTERVAL_MS = 2_000
const CONNECT_POLL_LIMIT_MS = 180_000
const HEALTH_RETRY = 8
const HEALTH_INTERVAL_MS = 1_000
const OP_TIMEOUT_MS = 600_000

export class RemoteEngine {
  private store: StoreFile = { version: 1, connections: [], manifest: {} }
  private readonly runtimes = new Map<string, ConnRuntime>()
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
    return this.store.connections.map((connection) => ({ ...connection, state: this.stateOf(connection.id) }))
  }

  stateOf(id: string): ConnState {
    const runtime = this.runtimeOf(id)
    return {
      phase: runtime.phase,
      op: runtime.op === null ? null : { ...runtime.op },
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

  connectionOf(id: string): RemoteConnection {
    const connection = this.store.connections.find((candidate) => candidate.id === id)
    if (connection === undefined) throw new NotFoundError(id)
    return connection
  }

  async save(request: SaveRequest): Promise<{ id: string }> {
    await this.load()
    const previous = request.id === undefined ? undefined : this.connectionOf(request.id)
    // save 只管基本信息；运行中修改会让转发进程锚在旧别名上——须先断开。
    // 同步勾选不经 save（随 startSync 直传），无此限制。
    if (previous !== undefined && this.runtimeOf(previous.id).running !== null) {
      throw new BusyError('连接使用中不能修改基本信息，请先断开')
    }
    const ids = new Set(
      this.store.connections
        .filter((candidate) => candidate.id !== previous?.id)
        .map((candidate) => candidate.id),
    )
    const connection = normalizeConnection(request, ids, this.deps.now(), previous)
    if (previous === undefined) this.store.connections.push(connection)
    else
      this.store.connections = this.store.connections.map((row) =>
        row.id === connection.id ? connection : row,
      )
    this.runtimeOf(connection.id)
    await this.persist()
    return { id: connection.id }
  }

  async remove(id: string): Promise<void> {
    await this.load()
    this.connectionOf(id)
    const runtime = this.runtimeOf(id)
    if (runtime.op !== null || runtime.running !== null) throw new BusyError()
    this.store.connections = this.store.connections.filter((candidate) => candidate.id !== id)
    delete this.store.manifest[id]
    this.runtimes.delete(id)
    await this.persist()
  }

  /** 同步预占操作位（互斥在事件循环同一 tick 内完成，双击不会双跑）。
   *  本机缺 ssh 的失败分类由 ssh 执行器在 spawn 时给出（local-tool-missing）。 */
  private beginOp(id: string, op: ConnOp, phase: ConnRuntime['phase']): RemoteConnection {
    const connection = this.connectionOf(id)
    const runtime = this.runtimeOf(id)
    if (runtime.op !== null) throw new BusyError()
    runtime.op = op
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
        ? { message: error.message, kind: error.kind }
        : { message: errMsg(error), kind: 'unknown' }
  }

  private step(id: string, step: string, detail?: string): void {
    const runtime = this.runtimeOf(id)
    if (runtime.op === null) return
    runtime.op = { ...runtime.op, step, detail }
  }

  private restPhase(runtime: ConnRuntime): 'idle' | 'running' {
    return runtime.running !== null ? 'running' : 'idle'
  }

  async test(id: string): Promise<TestResponse> {
    await this.load()
    const connection = this.beginOp(id, { kind: 'test', step: 'probe' }, 'probing')
    const runtime = this.runtimeOf(id)
    const backTo = (response: TestResponse): TestResponse => {
      runtime.op = null
      runtime.phase = this.restPhase(runtime)
      return response
    }
    try {
      const combined = await this.deps.exec(connection.sshAlias, 'node -v && npm -v && (dsh -V || true)', {
        timeoutMs: 20_000,
      })
      const lines = combined.stdout.trim().split(/\r?\n/)
      return backTo({
        ok: true,
        nodeVersion: lines[0] ?? null,
        npmVersion: lines[1] ?? null,
        dshVersion: lines[2] && lines[2].length > 0 ? lines[2] : null,
        error: null,
      })
    } catch (error) {
      const failure = error instanceof SshFailure ? error : new SshFailure('unknown', errMsg(error))
      if (failure.kind === 'remote-cmd-failed') {
        // 连接通但 node 缺失：算探针结果而非连接故障
        const node = await this.deps.exec(connection.sshAlias, 'node -v || true')
        return backTo({
          ok: false,
          nodeVersion: node.code === 0 && node.stdout.trim().length > 0 ? node.stdout.trim() : null,
          npmVersion: null,
          dshVersion: null,
          error: { message: failure.message, kind: failure.kind },
        })
      }
      return backTo({
        ok: false,
        nodeVersion: null,
        npmVersion: null,
        dshVersion: null,
        error: { message: failure.message, kind: failure.kind },
      })
    }
  }

  startConnect(id: string): void {
    const connection = this.beginOp(id, { kind: 'connect', step: 'probe-node' }, 'deploying')
    void this.runConnect(connection)
  }

  /** 连接的部署段：环境探针 + dsh 版本对齐 + 本插件安装；已装齐时立即完成。
   *  失败原样抛给 runConnect 的 catch 统一 fail（error 阶段）。 */
  private async ensureDeployed(id: string): Promise<void> {
    const alias = this.connectionOf(id).sshAlias

    const node = await this.deps.exec(alias, 'node -v')
    if (node.code !== 0)
      throw new SshFailure('remote-cmd-failed', `远端未安装 Node（需 ≥22.19）：${node.stderr.trim()}`)
    this.step(id, 'probe-npm', node.stdout.trim())

    const npm = await this.deps.exec(alias, 'npm -v')
    if (npm.code !== 0) throw new SshFailure('remote-cmd-failed', `远端未安装 npm：${npm.stderr.trim()}`)
    this.step(id, 'ensure-pnpm', npm.stdout.trim())

    let pnpm = await this.deps.exec(alias, 'pnpm -v')
    if (pnpm.code !== 0) {
      await this.deps.exec(alias, 'corepack enable', { timeoutMs: 60_000 })
      pnpm = await this.deps.exec(alias, 'pnpm -v')
    }
    if (pnpm.code !== 0) {
      throw new SshFailure(
        'remote-cmd-failed',
        '远端无 pnpm 且 corepack enable 未能提供：请手动安装 pnpm（插件安装依赖它）',
      )
    }

    // 远端 dsh 版本对齐本机；探测失败直接终止——npm 的 latest 标签可能落后
    // 于 next（实测 latest=0.1.7-rc.2、0.2 线在 next），回退安装会装出旧版本线，触发
    // 插件的 engines 版本闸门。
    const wantVersion = this.deps.localDshVersion
    if (wantVersion === null) {
      throw new SshFailure(
        'unknown',
        '本机 dsh 运行时版本探测失败（@deepseek-ai/dsh-app-boot 不可达）：远端不回退安装 latest，已中止装配',
      )
    }
    this.step(id, 'install-dsh', wantVersion)
    const existing = await this.deps.exec(alias, 'dsh -V')
    if (existing.code !== 0 || existing.stdout.trim() !== wantVersion) {
      const install = await this.deps.exec(
        alias,
        `npm install -g ${shQuote(`@deepseek-ai/dsh@${wantVersion}`)}`,
        {
          timeoutMs: OP_TIMEOUT_MS,
        },
      )
      if (install.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端安装 @deepseek-ai/dsh 失败：${install.stderr.trim().slice(0, 300)}`,
        )
      }
    }

    // 远端默认只装本插件——tgz 推送安装（无 scope 包名 dsh-remote 在 npm 已被第三方
    // 包占用，不能走 registry）；版本与 profile 登记都一致时跳过。
    this.step(id, 'install-plugin', REMOTE_PLUGIN_NAME)
    const localPluginVersion = this.deps.localPluginVersion
    const remoteModulePkg = `~/.dsh/profiles/${REMOTE_PROFILE}/node_modules/${REMOTE_PLUGIN_NAME}/package.json`
    const remoteProfilePkg = `~/.dsh/profiles/${REMOTE_PROFILE}/package.json`
    const installedPkg = await this.deps.exec(alias, `cat ${remoteModulePkg} 2>/dev/null || true`)
    const registered = await this.deps.exec(
      alias,
      `grep -q ${shQuote(REMOTE_PLUGIN_NAME)} ${remoteProfilePkg}`,
    )
    let remoteVersion: string | null = null
    try {
      const parsed = JSON.parse(installedPkg.stdout) as { version?: unknown }
      remoteVersion = typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
    } catch {
      // 未安装（cat 空）或输出异常：都按未安装处理
    }
    if (registered.code === 0 && remoteVersion !== null && remoteVersion === localPluginVersion) {
      this.step(id, 'verify', `已装 ${REMOTE_PLUGIN_NAME}@${remoteVersion}，跳过`)
    } else {
      const packed = await this.deps.packPlugin()
      this.step(id, 'push', packed.fileName)
      await this.deps.pushFile(alias, packed.path, '~/.dsh/dsh-remote/payload', packed.fileName)
      this.step(id, 'install-plugin', packed.fileName)
      const add = await this.deps.exec(
        alias,
        `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add "$HOME/.dsh/dsh-remote/payload/${packed.fileName}"`,
        {
          timeoutMs: OP_TIMEOUT_MS,
        },
      )
      if (add.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端安装 ${REMOTE_PLUGIN_NAME} 失败：${installFailureDetail(add.stdout, add.stderr)}`,
        )
      }
      // 假阳性防线：add 退出码 0 不等于装上——读回 node_modules 的版本确认
      this.step(id, 'verify')
      const settled = await this.deps.exec(alias, `cat ${remoteModulePkg}`)
      let settledVersion: string | null = null
      try {
        const parsed = JSON.parse(settled.stdout) as { version?: unknown }
        settledVersion =
          typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
      } catch {
        // 读不回即视为未装上
      }
      if (settled.code !== 0 || settledVersion === null) {
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
  }

  private async runConnect(connection: RemoteConnection): Promise<void> {
    const id = connection.id
    try {
      const alias = connection.sshAlias
      const runtime = this.runtimeOf(id)
      // 重连先杀旧转发：error 阶段重连时旧句柄仍在（fail 不清 forward），不杀
      // 会被新 forward 覆盖句柄，泄漏为无主 ssh 进程（实测累积过 4 个）
      runtime.forward?.kill()
      runtime.forward = null
      runtime.running = null

      // 部署段先行（幂等，已装齐时直接跳过）；装配完成进入启动段（阶段驱动面板 pill）
      await this.ensureDeployed(id)
      runtime.phase = 'starting'

      const log = `~/.dsh/dsh-remote/${id}.log`
      const pidFile = `~/.dsh/dsh-remote/${id}.pid`
      this.step(id, 'start', REMOTE_PROFILE)
      // pid 文件里的实例仍在运行就复用（重试连接不再叠加新实例，token 不变）；
      // 日志与 pid 由同一次启动写入，存活即两者一致。
      const start = await this.deps.exec(
        alias,
        `pid=$(cat ${pidFile} 2>/dev/null); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo reuse:$pid; else mkdir -p ~/.dsh/dsh-remote; nohup dsh --profile ${shQuote(REMOTE_PROFILE)} --no-open --port 0 > ${log} 2>&1 & echo $! > ${pidFile}; fi`,
        { timeoutMs: 30_000 },
      )
      if (start.code !== 0)
        throw new SshFailure('remote-cmd-failed', `远端实例启动失败：${start.stderr.trim()}`)

      this.step(id, 'poll', '等待就绪信号')
      const maxAttempts = Math.ceil(CONNECT_POLL_LIMIT_MS / CONNECT_POLL_INTERVAL_MS)
      let launch: RemoteLaunch | undefined
      for (let attempt = 0; attempt < maxAttempts && launch === undefined; attempt += 1) {
        await this.deps.delay(CONNECT_POLL_INTERVAL_MS)
        const grep = await this.deps.exec(alias, `grep -m1 '^dsh web: ' ${log} || true`, {
          timeoutMs: 15_000,
        })
        launch = parseLaunchFromLog(grep.stdout)
      }
      if (launch === undefined) {
        const tail = await this.deps.exec(alias, `tail -n 20 ${log} || true`)
        throw new SshFailure(
          'timeout',
          `远端实例 ${CONNECT_POLL_LIMIT_MS / 1000}s 内未输出就绪信号。日志尾部：\n${tail.stdout.trim().slice(-800)}`,
        )
      }

      this.step(id, 'forward', `127.0.0.1 → 远端 :${launch.remotePort}`)
      const pidText = await this.deps.exec(alias, `cat ${pidFile} || true`)
      const pid = Number.parseInt(pidText.stdout.trim(), 10)
      const localPort = await this.deps.freeLocalPort()
      const forward = this.deps.startForward(alias, localPort, launch.remotePort)
      runtime.forward = forward
      forward.onExit(() => {
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

      this.step(id, 'health', `http://127.0.0.1:${localPort}/`)
      let healthy = false
      for (let attempt = 0; attempt < HEALTH_RETRY && !healthy; attempt += 1) {
        await this.deps.delay(HEALTH_INTERVAL_MS)
        healthy = await this.deps.healthCheck(`http://127.0.0.1:${localPort}/`)
      }
      if (!healthy) {
        forward.kill()
        runtime.forward = null
        throw new SshFailure(
          'unreachable',
          '端口转发健康检查失败：本机未能经隧道取到任何 HTTP 响应（检查远端 sshd 的 AllowTcpForwarding 是否放行 -L）',
        )
      }

      const url = rewriteLaunchUrl(`http://127.0.0.1:${launch.remotePort}/?token=${launch.token}`, localPort)
      if (url === undefined) throw new SshFailure('unknown', '就绪信号解析失败')
      runtime.running = {
        url,
        localPort,
        remotePort: launch.remotePort,
        pid: Number.isInteger(pid) ? pid : 0,
        since: this.deps.now(),
      }
      // 转发进程与内存句柄可能同时幸存于宿主重启——租约落盘供下次 load 清扫
      if (forward.pid !== null) {
        await this.deps.forwards.record(id, {
          pid: forward.pid,
          localPort,
          remotePort: launch.remotePort,
          at: this.deps.now(),
        })
      }
      this.settle(id, 'running')
    } catch (error) {
      this.fail(id, error)
    }
  }

  startDisconnect(id: string): void {
    const connection = this.beginOp(id, { kind: 'disconnect', step: 'stop-forward' }, 'stopping')
    void this.runDisconnect(connection)
  }

  /** 宿主卸载插件（含退出）时杀掉全部本地转发；远端实例不动（仍在远端运行，
   *  下次连接按 pid 复用）。租约清空是尽力而为（进程退出不等异步写完成），
   *  漏掉的由下次 load 的清扫兜底（死 pid 直接清记录）。 */
  dispose(): void {
    for (const runtime of this.runtimes.values()) {
      runtime.forward?.kill()
      runtime.forward = null
    }
    void this.deps.forwards.clearAll()
  }

  private async runDisconnect(connection: RemoteConnection): Promise<void> {
    const id = connection.id
    try {
      const runtime = this.runtimeOf(id)
      runtime.forward?.kill()
      runtime.forward = null
      await this.deps.forwards.clear(id)

      this.step(id, 'stop-remote')
      const pidFile = `~/.dsh/dsh-remote/${id}.pid`
      const stop = await this.deps.exec(
        connection.sshAlias,
        `pid=$(cat ${pidFile} 2>/dev/null); if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" && rm -f ${pidFile} ~/.dsh/dsh-remote/${id}.log; else rm -f ${pidFile}; fi`,
        { timeoutMs: 30_000 },
      )
      if (stop.code !== 0)
        throw new SshFailure('remote-cmd-failed', `远端实例停止失败：${stop.stderr.trim()}`)
      runtime.running = null
      this.settle(id, 'idle')
    } catch (error) {
      this.fail(id, error)
    }
  }

  /** 远端一个 skills 根的技能内容指纹：find|sha256 管线一次取整根文件摘要，
   *  host 侧按顶层段折成 name → digest（与 localenv.foldSkillDigest 同一折叠）。
   *  hasher 缺失 / 命令失败回 null——该根全部按「无法比对」保守推送。
   *  刻意不比 mtime / mode：声明语义只关心内容字节。 */
  private async remoteSkillFacts(
    alias: string,
    key: 'user-dsh' | 'user-agents',
  ): Promise<RemoteSkillFact[] | null> {
    const root = key === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills'
    const list = await this.deps.exec(
      alias,
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

  /** 远端 patch 内 MCP 行的事实（serverName → 行 id / 配置签名 / 摘要；手写行
   *  id 不必循命名约定，按 serverName 对齐）。 */
  private mcpFactsOfDoc(
    doc: ReturnType<typeof parsePatchDoc>,
  ): Map<string, { id: string; signature: string; summary: string }> {
    const facts = new Map<string, { id: string; signature: string; summary: string }>()
    for (const row of scanInserts(doc)) {
      if (row.name !== MCP_PLUGIN_NAME) continue
      const serverName = asServerName(row.config)
      if (serverName === undefined) continue
      const config =
        typeof row.config === 'object' && row.config !== null && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {}
      facts.set(serverName, {
        id: row.id,
        signature: mcpSignature(config, row.disabled === true),
        summary: mcpSummary(config),
      })
    }
    return facts
  }

  /** 远端插件事实：bundles 激活清单 + 激活插件的已装版本与包树内容指纹（一条
   *  node 批量读，部署前置保证远端有 node；realpath 穿透 node_modules 符号链接，
   *  脚本见 REMOTE_PLUGIN_FACTS_SCRIPT）。任一环节失败回 null——按「无法比对」
   *  处理，同步侧保守安装。 */
  private async remotePluginFacts(
    alias: string,
    names: readonly string[],
  ): Promise<RemotePluginFact[] | null> {
    const pkg = `~/.dsh/profiles/${REMOTE_PROFILE}/package.json`
    const current = await this.deps.exec(alias, `cat ${pkg} 2>/dev/null || true`)
    let bundles: string[]
    try {
      const parsed = JSON.parse(current.stdout) as { dsh?: { profile?: { bundles?: unknown } } }
      const raw = parsed.dsh?.profile?.bundles
      bundles = Array.isArray(raw) ? raw.filter((name): name is string => typeof name === 'string') : []
    } catch {
      return null
    }
    const facts = new Map<string, { version: string | null; digest: string | null }>()
    const probe = bundles.filter((name) => names.includes(name))
    if (probe.length > 0) {
      const read = await this.deps.exec(
        alias,
        `cd ~/.dsh/profiles/${REMOTE_PROFILE}/node_modules && node -e ${shQuote(
          REMOTE_PLUGIN_FACTS_SCRIPT,
        )} ${probe.map((name) => shQuote(name)).join(' ')}`,
        { timeoutMs: 60_000 },
      )
      if (read.code !== 0) return null
      for (const line of read.stdout.split(/\r?\n/)) {
        // 输出行形态：`<name>\t<version>\t<digest>`（version / digest 空串 = 读不到）
        const first = line.indexOf('\t')
        if (first <= 0) continue
        const second = line.indexOf('\t', first + 1)
        if (second === -1) continue
        const version = line.slice(first + 1, second).trim()
        const digest = line.slice(second + 1).trim()
        facts.set(line.slice(0, first), {
          version: version.length > 0 ? version : null,
          digest: digest.length > 0 ? digest : null,
        })
      }
    }
    return bundles.map((name) => ({
      name,
      version: facts.get(name)?.version ?? null,
      digest: facts.get(name)?.digest ?? null,
    }))
  }

  /** 远端全局提示词事实：单文件 sha256（sha256sum / shasum 择一，文件缺失打
   *  __ABSENT__ 哨兵、hasher 缺失打 __NO_HASHER__）。命令失败回 null——按
   *  「无法比对」处理，同步侧保守推送。仅需 ssh 可达（同 skills / MCP）。 */
  private async remotePromptFact(alias: string): Promise<RemotePromptFact | null> {
    const file = '~/.dsh/AGENTS.md'
    const out = await this.deps.exec(
      alias,
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
    const alias = this.connectionOf(id).sshAlias
    const skills = {
      'user-dsh': await this.remoteSkillFacts(alias, 'user-dsh'),
      'user-agents': await this.remoteSkillFacts(alias, 'user-agents'),
    }
    const patch = await this.deps.exec(
      alias,
      `cat ~/.dsh/profiles/${shQuote(REMOTE_PROFILE)}/cordis.patch.yml || true`,
    )
    let mcp: RemoteMcpFact[] | null = []
    if (patch.stdout.trim().length > 0) {
      try {
        mcp = [...this.mcpFactsOfDoc(parsePatchDoc(patch.stdout))].map(([serverName, fact]) => ({
          serverName,
          signature: fact.signature,
          summary: fact.summary,
        }))
      } catch {
        // 远端 patch 语法坏：无法比对（写入侧 doMcpSync 会显式失败并报原因）
        mcp = null
      }
    }
    const { pluginRows } = await composeLocalRows(await this.deps.readLocalLayers())
    const plugins = await this.remotePluginFacts(
      alias,
      pluginRows.map((row) => row.name),
    )
    const prompts = await this.remotePromptFact(alias)
    return { skills, mcp, plugins, prompts }
  }

  /** 触发同步：names 为勾选项（勾选 = 安装/覆盖，指纹一致项引擎侧跳过；
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
    this.beginOp(id, { kind: kindOfOp, step: kind === 'skills' ? 'scan' : 'read-local' }, restPhase)
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

  /** Skills 同步：勾选且指纹不同的按根打包推送；一致项跳过（不重传）；
   *  未勾选不动——同步只往远端新增/覆盖，不删除远端内容。 */
  private async doSkillsSync(id: string, selected: ReadonlySet<string>): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const next: Record<string, string[]> = {}
    let pushed = 0
    let skipped = 0
    for (const root of await this.deps.scanSkills()) {
      const remoteRoot = root.key === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills'
      const picked = root.rows.filter((row) => selected.has(row.name))
      // 该根无勾选项：既不推送也无需取远端指纹（省两次 ssh 往返）
      if (picked.length === 0) {
        next[root.key] = []
        continue
      }
      const facts = await this.remoteSkillFacts(connection.sshAlias, root.key)
      const factByName = new Map((facts ?? []).map((fact) => [fact.name, fact]))
      const chosen: string[] = []
      for (const row of picked) {
        const status = facts === null ? 'unknown' : skillStatus(row.digest, factByName.get(row.name))
        if (status === 'same') skipped += 1
        else chosen.push(row.name)
      }
      next[root.key] = chosen
      if (chosen.length > 0) {
        this.step(id, 'push', `${root.key} ${chosen.length} 项`)
        await this.deps.pushTar(connection.sshAlias, root.path, remoteRoot, chosen)
        pushed += chosen.length
      }
    }
    this.store.manifest[id] = { ...this.manifestOf(id), skills: next }
    await this.persist()
    runtime.lastSync.skills = { at: this.deps.now(), pushed, skipped }
  }

  /** MCP 同步：本机两层 patch fold 出选中 serverName 的生效配置，只把签名不同的
   *  行写进远端 profile patch——一致项跳过，全部一致则整次不写盘（不触发远端
   *  HMR / mtime 抖动）。远端手写行（同 serverName 不同 id）被本机行替换：
   *  覆盖语义，不是删除远端条目。未勾选不动。 */
  private async doMcpSync(id: string, selected: ReadonlySet<string>): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const layers = await this.deps.readLocalLayers()
    const rows: {
      serverName: string
      id: string
      name: string
      config: Record<string, unknown>
      disabled?: boolean
    }[] = []
    for (const entry of foldMcpRows(layers)) {
      const serverName = asServerName(entry.config)
      if (serverName === undefined || !selected.has(serverName)) continue
      rows.push({
        serverName,
        id: entry.row.id,
        name: MCP_PLUGIN_NAME,
        config: entry.config,
        // 只写 true：显式 false 会渲染成 YAML 行（upsertInsertRow 对 undefined 不写）
        disabled: entry.disabled || undefined,
      })
    }

    const remotePatch = `~/.dsh/profiles/${REMOTE_PROFILE}/cordis.patch.yml`
    this.step(id, 'read-remote', remotePatch)
    const current = await this.deps.exec(connection.sshAlias, `cat ${remotePatch} || true`)
    const doc = current.stdout.trim().length === 0 ? emptyPatchDoc() : parsePatchDoc(current.stdout)
    const remoteFacts = this.mcpFactsOfDoc(doc)

    const writes: typeof rows = []
    const skipped: string[] = []
    const replacedIds = new Set<string>()
    for (const row of rows) {
      const fact = remoteFacts.get(row.serverName)
      if (fact !== undefined) {
        if (fact.signature === mcpSignature(row.config, row.disabled === true)) {
          skipped.push(row.serverName)
          continue
        }
        if (fact.id !== row.id) replacedIds.add(fact.id)
      }
      writes.push(row)
    }
    const installed = writes.map((row) => row.id)

    if (writes.length > 0) {
      this.step(id, 'merge', `${writes.length} 行`)
      if (replacedIds.size > 0) removeInsertRows(doc, replacedIds)
      for (const row of writes) upsertInsertRow(doc, row)

      this.step(id, 'write-remote')
      await this.deps.exec(connection.sshAlias, `mkdir -p ~/.dsh/profiles/${shQuote(REMOTE_PROFILE)}`)
      const write = await this.deps.exec(
        connection.sshAlias,
        `cat > ${remotePatch}.tmp-dsh-remote && mv ${remotePatch}.tmp-dsh-remote ${remotePatch}`,
        { stdin: renderPatchDoc(doc) },
      )
      if (write.code !== 0)
        throw new SshFailure('remote-cmd-failed', `远端 patch 写入失败：${write.stderr.trim()}`)
    }

    this.store.manifest[id] = { ...this.manifestOf(id), mcp: installed }
    await this.persist()
    runtime.lastSync.mcp = { at: this.deps.now(), installed, skipped }
  }

  /** 插件同步：勾选项逐个比对远端事实，一致跳过，其余安装。比对值按传输形态
   *  选——本地打包传输比内容指纹（开发版同版本换内容只有指纹可见，且 payload
   *  文件名内容寻址，指纹变化必换名重装：hoisted linker 下同版本换内容不换名
   *  会被 pnpm 以 Already up to date 跳过重新解包）；远端 npm 下载比版本
   *  （npm 同版本内容不可变）。值同但未激活（不在 bundles）也走重装——否则
   *  已安装但未激活的插件永远无法激活。未勾选不动（不删除）。
   *  registry 插件按调用选项分流推送 / 远端 npm 下载；本地路径安装恒本地打包
   *  传输（未发布的开发版本也只有这条路径能到达远端）。 */
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
    const facts = await this.remotePluginFacts(
      connection.sshAlias,
      pluginRows.map((row) => row.name),
    )
    const factByName = facts === null ? null : new Map(facts.map((fact) => [fact.name, fact]))

    const installed: string[] = []
    const skipped: string[] = []
    for (const name of selected) {
      const row = byName.get(name)
      if (row === undefined) continue
      const fact = factByName?.get(name)
      const viaPush = row.install === 'local' || registryInstall === 'push'
      const status =
        factByName === null
          ? 'unknown'
          : viaPush
            ? pluginStatus(row.digest, fact?.digest)
            : pluginStatus(row.version, fact?.version)
      if (status === 'same') {
        skipped.push(name)
        continue
      }

      this.step(id, 'install', row.name)
      const install = viaPush
        ? await this.addViaPush(connection.sshAlias, row)
        : await this.deps.exec(
            connection.sshAlias,
            `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add ${shQuote(row.version === null ? row.name : `${row.name}@${row.version}`)}`,
            { timeoutMs: OP_TIMEOUT_MS },
          )
      if (install.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端安装 ${row.name} 失败：${installFailureDetail(install.stdout, install.stderr)}`,
        )
      }
      installed.push(row.name)
    }

    this.store.manifest[id] = { ...this.manifestOf(id), plugins: selected }
    await this.persist()
    runtime.lastSync.plugins = { at: this.deps.now(), installed, skipped }
  }

  /** 提示词同步：勾选且内容指纹不同才推送（tmp+mv 原子落盘远端 AGENTS.md）；
   *  一致跳过，未勾选不动。远端实例在下一次尚未开始的模型步骤读取新内容。 */
  private async doPromptSync(id: string, selected: ReadonlySet<string>): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const content = await this.deps.readGlobalPrompt()
    if (content === null) {
      throw new SshFailure('unknown', '本机没有全局提示词文件（AGENTS.md），无可同步')
    }
    let pushed = false
    let skipped = false
    if (selected.size > 0) {
      const digest = createHash('sha256').update(content, 'utf8').digest('hex')
      const status = promptStatus(digest, await this.remotePromptFact(connection.sshAlias))
      if (status === 'same') skipped = true
      else {
        const target = '~/.dsh/AGENTS.md'
        this.step(id, 'push', 'AGENTS.md')
        const write = await this.deps.exec(
          connection.sshAlias,
          `mkdir -p ~/.dsh && cat > ${target}.tmp-dsh-remote && mv ${target}.tmp-dsh-remote ${target}`,
          { stdin: content },
        )
        if (write.code !== 0) {
          throw new SshFailure(
            'remote-cmd-failed',
            `远端提示词写入失败：${write.stderr.trim().slice(0, 200)}`,
          )
        }
        pushed = true
      }
    }
    this.store.manifest[id] = { ...this.manifestOf(id), prompts: pushed }
    await this.persist()
    runtime.lastSync.prompts = { at: this.deps.now(), pushed, skipped }
  }

  /** 打包本机包根 → 推送 payload → 远端 add tgz → 清同包旧指纹文件（本地路径
   *  插件与选项 push 的 registry 插件共用；payload 只是传输介质，装入
   *  node_modules 后即可清，目录不随内容迭代堆积）。 */
  private async addViaPush(
    alias: string,
    row: { name: string; root: string | null },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (row.root === null) {
      throw new SshFailure('unknown', `本机未能定位 ${row.name} 的包目录，无法本地传输；请检查其安装后重试`)
    }
    const packed = await this.deps.packPackage(row.root)
    await this.deps.pushFile(alias, packed.path, '~/.dsh/dsh-remote/payload', packed.fileName)
    const install = await this.deps.exec(
      alias,
      `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add "$HOME/.dsh/dsh-remote/payload/${packed.fileName}"`,
      { timeoutMs: OP_TIMEOUT_MS },
    )
    if (install.code === 0) {
      // 文件名形如 <base>-<version>-<指纹8>.tgz。当前文件必须保留：package.json 的
      // file: spec 持续指向它，pnpm 后续任何 add/install 都会重读全部 file: 依赖——
      // 只清同包更早的指纹变体（装完即无人引用）。
      const stem = packed.fileName.slice(0, packed.fileName.lastIndexOf('-'))
      await this.deps.exec(
        alias,
        `find ~/.dsh/dsh-remote/payload -maxdepth 1 -name '${stem}-*.tgz' ! -name '${packed.fileName}' -delete || true`,
      )
    }
    return install
  }
}
