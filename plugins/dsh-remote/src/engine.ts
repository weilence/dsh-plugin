/**
 * 连接引擎（host 专用）：每个连接一台内存状态机（相位 + 进行中操作 +
 * running 事实 + 最近同步摘要），互斥由「op 非空即拒绝」保证；长操作
 * （部署 / 连接 / 同步）由路由点火后在后台推进，面板轮询 GET /state 观察。
 *
 * 远端操作面（全部经 ssh，登录 shell 包装保证 PATH）：
 * - 部署：node/npm/pnpm 探针 → npm i -g dsh（版本对齐本机）→ 对比远端
 *   已装 @weilence/dsh-remote 版本，不一致才本地打包 tgz 推送并经
 *   `dsh plugin add <tgz>` 安装（包名被第三方占用，不走 registry）。
 * - 连接：nohup 起实例 → 轮询日志 token 行 → 本地端口转发 → 健康检查。
 * - 同步：skills tar 单向推送 + manifest 跟踪式删除；MCP 行 cat→改→cat
 *   合并进远端 profile patch；插件逐个版本对比——本地路径安装恒 tgz 推送，
 *   registry 插件按连接选项推送或远端 npm 下载。
 */

import type { ForwardHandle, SshExec } from './ssh'
import { SshFailure, shQuote } from './ssh'
import { parseLaunchFromLog, rewriteLaunchUrl, type RemoteLaunch } from './launch'
import { normalizeConnection, readStore, writeStore, type SyncManifest, type StoreFile } from './connections'
import { composeLocalRows, foldMcpRows, scanSkillsNames, skillsRoots, type LocalPatchLayer } from './localenv'
import { emptyPatchDoc, parsePatchDoc, removeInsertRows, renderPatchDoc, upsertInsertRow } from './patchDoc'
import {
  MCP_PLUGIN_NAME,
  REMOTE_PLUGIN_NAME,
  REMOTE_PROFILE,
  type ConnOp,
  type ConnRow,
  type ConnState,
  type RemoteConnection,
  type SaveRequest,
  type SshErrorKind,
  type SyncKind,
  type TestResponse,
} from './shared'

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
  scanSkills(): Promise<{ key: string; path: string; names: string[] }[]>
  /** 本机 dsh 运行时版本（部署对齐目标）；解析失败为 null = 远端装 latest。 */
  localDshVersion: string | null
  /** 本插件版本（package.json；部署版本对比目标）；未知为 null。 */
  localPluginVersion: string | null
  /** 本地打包本插件 tgz（部署自装用）；失败抛 SshFailure。 */
  packPlugin(): Promise<{ path: string; fileName: string }>
  /** 本地打包任意本机插件包根目录（插件同步传输用）；失败抛 SshFailure。 */
  packPackage(root: string): Promise<{ path: string; fileName: string }>
  tools: { ssh: boolean; tar: boolean }
  homeDir: string
  now(): string
  delay(ms: number): Promise<void>
}

/** 操作被占用（路由转 409）。 */
export class BusyError extends Error {
  constructor() {
    super('该连接已有操作进行中')
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
    lastSync: { skills: null, mcp: null, plugins: null },
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
    return this.store.manifest[id] ?? { skills: {}, mcp: [], plugins: [] }
  }

  private async persist(): Promise<void> {
    await writeStore(this.deps.homeDir, this.store)
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.store = await readStore(this.deps.homeDir)
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
    if (previous !== undefined && this.runtimeOf(previous.id).running !== null) throw new BusyError()
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

  private assertTools(): void {
    if (!this.deps.tools.ssh)
      throw new SshFailure('local-tool-missing', '本机未找到 ssh 可执行文件，无法执行远端操作')
  }

  /** 同步预占操作位（互斥在事件循环同一 tick 内完成，双击不会双跑）。 */
  private beginOp(id: string, op: ConnOp, phase: ConnRuntime['phase']): RemoteConnection {
    const connection = this.connectionOf(id)
    const runtime = this.runtimeOf(id)
    if (runtime.op !== null) throw new BusyError()
    this.assertTools()
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
    runtime.op = null
    runtime.phase = 'error'
    runtime.error =
      error instanceof SshFailure
        ? { message: error.message, kind: error.kind }
        : { message: error instanceof Error ? error.message : String(error), kind: 'unknown' }
    runtime.running = null
  }

  private step(id: string, step: string, detail?: string): void {
    const runtime = this.runtimeOf(id)
    if (runtime.op === null) return
    runtime.op = { ...runtime.op, step, ...(detail !== undefined ? { detail } : {}) }
  }

  private restPhase(runtime: ConnRuntime): 'idle' | 'running' {
    return runtime.running !== null ? 'running' : 'idle'
  }

  // ---- 探针（同步等待，结果随响应返回；失败不污染连接相位） ----

  async test(id: string): Promise<TestResponse> {
    await this.load()
    const runtime = this.runtimeOf(id)
    const restore: 'idle' | 'running' = runtime.running !== null ? 'running' : 'idle'
    const connection = this.beginOp(id, { kind: 'test', step: 'probe' }, 'probing')
    const backTo = (response: TestResponse): TestResponse => {
      runtime.op = null
      runtime.phase = restore
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
      const failure = error instanceof SshFailure ? error : new SshFailure('unknown', String(error))
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

  // ---- 一键部署（远端默认只装 dsh-remote） ----

  startDeploy(id: string): void {
    const connection = this.beginOp(id, { kind: 'deploy', step: 'probe-node' }, 'deploying')
    void this.runDeploy(connection)
  }

  private async runDeploy(connection: RemoteConnection): Promise<void> {
    const id = connection.id
    try {
      const alias = connection.sshAlias

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

      // 远端 dsh 版本对齐本机（本机版本未知时退 latest）
      const wantVersion = this.deps.localDshVersion
      this.step(id, 'install-dsh', wantVersion ?? 'latest')
      const existing = await this.deps.exec(alias, 'dsh -V')
      if (existing.code !== 0 || (wantVersion !== null && existing.stdout.trim() !== wantVersion)) {
        const spec = wantVersion === null ? '@deepseek-ai/dsh' : `@deepseek-ai/dsh@${wantVersion}`
        const install = await this.deps.exec(alias, `npm install -g ${shQuote(spec)}`, {
          timeoutMs: OP_TIMEOUT_MS,
        })
        if (install.code !== 0) {
          throw new SshFailure(
            'remote-cmd-failed',
            `远端安装 @deepseek-ai/dsh 失败：${install.stderr.trim().slice(0, 300)}`,
          )
        }
      }

      // 远端默认只装本插件——tgz 推送安装（裸名 dsh-remote 在 npm 已被第三方
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
        remoteVersion =
          typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
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
            `远端安装 ${REMOTE_PLUGIN_NAME} 失败：${add.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)}`,
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
      this.settle(id, 'idle')
    } catch (error) {
      this.fail(id, error)
    }
  }

  // ---- 连接 / 断开 ----

  startConnect(id: string): void {
    const connection = this.beginOp(id, { kind: 'connect', step: 'start' }, 'starting')
    void this.runConnect(connection)
  }

  private async runConnect(connection: RemoteConnection): Promise<void> {
    const id = connection.id
    try {
      const alias = connection.sshAlias
      const runtime = this.runtimeOf(id)
      runtime.running = null

      const log = `~/.dsh/dsh-remote/${id}.log`
      const pidFile = `~/.dsh/dsh-remote/${id}.pid`
      this.step(id, 'start', REMOTE_PROFILE)
      // pid 文件里的实例仍活着就复用（重试连接不再叠加新实例，token 不变）；
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
      let launch: RemoteLaunch | undefined = undefined
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
      this.settle(id, 'running')
    } catch (error) {
      this.fail(id, error)
    }
  }

  startDisconnect(id: string): void {
    const connection = this.beginOp(id, { kind: 'disconnect', step: 'stop-forward' }, 'stopping')
    void this.runDisconnect(connection)
  }

  private async runDisconnect(connection: RemoteConnection): Promise<void> {
    const id = connection.id
    try {
      const runtime = this.runtimeOf(id)
      runtime.forward?.kill()
      runtime.forward = null

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

  // ---- 同步 ----

  startSync(id: string, kind: SyncKind): void {
    const restPhase = this.runtimeOf(id).running !== null ? 'running' : 'idle'
    const kindOfOp =
      kind === 'all'
        ? 'sync-all'
        : kind === 'skills'
          ? 'sync-skills'
          : kind === 'mcp'
            ? 'sync-mcp'
            : 'sync-plugins'
    this.beginOp(id, { kind: kindOfOp, step: kind === 'skills' ? 'scan' : 'read-local' }, restPhase)
    void (async () => {
      const runtime = this.runtimeOf(id)
      try {
        if (kind === 'skills' || kind === 'all') await this.doSkillsSync(id)
        if (kind === 'mcp' || kind === 'all') await this.doMcpSync(id)
        if (kind === 'plugins' || kind === 'all') await this.doPluginSync(id)
        this.settle(id, this.restPhase(runtime))
      } catch (error) {
        this.fail(id, error)
      }
    })()
  }

  /** skills 单向同步：勾选名按根打包推送 + manifest 跟踪式删除（仅手动触发）。 */
  private async doSkillsSync(id: string): Promise<void> {
    const runtime = this.runtimeOf(id)
    const connection = this.connectionOf(id)
    const manifest = this.manifestOf(id)
    const selected = new Set(connection.sync.skillNames)
    const next: Record<string, string[]> = {}
    let pushed = 0
    let deleted = 0
    let skipped = 0
    for (const root of await this.deps.scanSkills()) {
      // 只推勾选名；本根一个都没勾时记录空集（manifest 删除据此判定）
      const chosen = root.names.filter((name) => selected.has(name))
      next[root.key] = chosen
      if (chosen.length === 0) continue
      this.step(id, 'push', `${root.key} ${chosen.length} 项`)
      if (!this.deps.tools.tar) {
        skipped += chosen.length
        continue
      }
      const remoteRoot = root.key === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills'
      await this.deps.pushTar(connection.sshAlias, root.path, remoteRoot, chosen)
      pushed += chosen.length
    }
    for (const [key, previousNames] of Object.entries(manifest.skills)) {
      const current = new Set(next[key] ?? [])
      const gone = previousNames.filter((name) => !current.has(name))
      if (gone.length === 0) continue
      this.step(id, 'clean', `${gone.length} 项`)
      const remoteRoot = key === 'user-dsh' ? '~/.dsh/skills' : '~/.agents/skills'
      const targets = gone
        .map((name) => `${remoteRoot}/${shQuote(name)} ${remoteRoot}/${shQuote(`${name}.md`)}`)
        .join(' ')
      const remove = await this.deps.exec(connection.sshAlias, `rm -rf ${targets}`)
      if (remove.code !== 0) {
        throw new SshFailure(
          'remote-cmd-failed',
          `远端清理失效技能失败：${remove.stderr.trim().slice(0, 200)}`,
        )
      }
      deleted += gone.length
    }
    this.store.manifest[id] = { ...this.manifestOf(id), skills: next }
    await this.persist()
    runtime.lastSync.skills = { at: this.deps.now(), pushed, deleted, skipped }
  }

  /** MCP 下发：本机两层 patch fold 出选中 serverName 的生效配置，整块写进远端 profile patch。 */
  private async doMcpSync(id: string): Promise<void> {
    const runtime = this.runtimeOf(id)
    {
      const connection = this.connectionOf(id)
      const layers = await this.deps.readLocalLayers()
      const selected = new Set(connection.sync.mcpServerNames)
      const rows: { id: string; name: string; config: Record<string, unknown>; disabled?: boolean }[] = []
      for (const entry of foldMcpRows(layers)) {
        const serverName = typeof entry.config.serverName === 'string' ? entry.config.serverName : undefined
        if (serverName === undefined || !selected.has(serverName)) continue
        rows.push({
          id: entry.row.id,
          name: MCP_PLUGIN_NAME,
          config: entry.config,
          ...(entry.disabled ? { disabled: true } : {}),
        })
      }
      const installed = rows.map((row) => row.id)

      const remotePatch = `~/.dsh/profiles/${REMOTE_PROFILE}/cordis.patch.yml`
      this.step(id, 'read-remote', remotePatch)
      const current = await this.deps.exec(connection.sshAlias, `cat ${remotePatch} || true`)
      const doc = current.stdout.trim().length === 0 ? emptyPatchDoc() : parsePatchDoc(current.stdout)

      const previous = new Set(this.manifestOf(id).mcp)
      const removed = [...previous].filter((rowId) => !installed.includes(rowId))
      this.step(id, 'merge', `${installed.length} 行`)
      for (const row of rows) upsertInsertRow(doc, row)
      if (removed.length > 0) removeInsertRows(doc, new Set(removed))

      this.step(id, 'write-remote')
      await this.deps.exec(connection.sshAlias, `mkdir -p ~/.dsh/profiles/${shQuote(REMOTE_PROFILE)}`)
      const write = await this.deps.exec(
        connection.sshAlias,
        `cat > ${remotePatch}.tmp-dsh-remote && mv ${remotePatch}.tmp-dsh-remote ${remotePatch}`,
        { stdin: renderPatchDoc(doc) },
      )
      if (write.code !== 0)
        throw new SshFailure('remote-cmd-failed', `远端 patch 写入失败：${write.stderr.trim()}`)

      this.store.manifest[id] = { ...this.manifestOf(id), mcp: installed }
      await this.persist()
      runtime.lastSync.mcp = { at: this.deps.now(), installed, removed }
    }
  }

  /** 插件同步：本地路径安装的插件永远本地打包传输（未发布的开发代码也只有
   *  这条路能到达远端）；registry 插件按连接选项分流（推送 / 远端 npm 下载）。
   *  逐插件版本对比，远端已同版本即跳过——重复同步幂等；取消勾选按 manifest 移除。 */
  private async doPluginSync(id: string): Promise<void> {
    const runtime = this.runtimeOf(id)
    {
      const connection = this.connectionOf(id)
      const { pluginRows } = await composeLocalRows(await this.deps.readLocalLayers())
      const byName = new Map(pluginRows.map((row) => [row.name, row]))
      // 本插件自身是部署基线（tgz 推送安装），不参与插件同步；旧裸名在
      // 本机改名重装前的过渡期一并排除。
      const isSelf = (name: string): boolean => name === REMOTE_PLUGIN_NAME || name === 'dsh-remote'
      const selected = connection.sync.pluginNames.filter((name) => !isSelf(name) && byName.has(name))
      const skipped = connection.sync.pluginNames.filter((name) => !isSelf(name) && !byName.has(name))
      const previous = this.manifestOf(id).plugins.filter((name) => !isSelf(name))
      const toRemove = previous.filter((name) => !selected.includes(name))

      const installed: string[] = []
      for (const name of selected) {
        const row = byName.get(name)
        if (row === undefined) continue
        // 版本对比：远端 node_modules 已装同版本 → 跳过
        const remotePkg = `~/.dsh/profiles/${REMOTE_PROFILE}/node_modules/${row.name}/package.json`
        const current = await this.deps.exec(connection.sshAlias, `cat ${remotePkg} 2>/dev/null || true`)
        let remoteVersion: string | null = null
        try {
          const parsed = JSON.parse(current.stdout) as { version?: unknown }
          remoteVersion =
            typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : null
        } catch {
          // cat 空（未装）：按未装处理
        }
        if (remoteVersion !== null && remoteVersion === row.version) continue

        this.step(id, 'install', row.name)
        const viaPush = row.install === 'local' || connection.sync.registryPluginInstall === 'push'
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
            `远端安装 ${row.name} 失败：${install.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)}`,
          )
        }
        installed.push(row.name)
      }

      if (toRemove.length > 0) {
        this.step(id, 'remove', toRemove.join(' '))
        const remove = await this.deps.exec(
          connection.sshAlias,
          `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} remove ${toRemove.map((name) => shQuote(name)).join(' ')}`,
          { timeoutMs: 300_000 },
        )
        if (remove.code !== 0) {
          throw new SshFailure(
            'remote-cmd-failed',
            `远端插件移除失败：${remove.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 300)}`,
          )
        }
      }

      this.store.manifest[id] = { ...this.manifestOf(id), plugins: selected }
      await this.persist()
      runtime.lastSync.plugins = { at: this.deps.now(), installed, removed: toRemove, skipped }
    }
  }

  /** 打包本机包根 → 推送 payload → 远端 add tgz（本地路径插件与选项 push 的 registry 插件共用）。 */
  private async addViaPush(
    alias: string,
    row: { name: string; root: string | null },
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (row.root === null) {
      throw new SshFailure('unknown', `本机未能定位 ${row.name} 的包目录，无法本地传输；请检查其安装后重试`)
    }
    const packed = await this.deps.packPackage(row.root)
    await this.deps.pushFile(alias, packed.path, '~/.dsh/dsh-remote/payload', packed.fileName)
    return this.deps.exec(
      alias,
      `dsh plugin --profile ${shQuote(REMOTE_PROFILE)} add "$HOME/.dsh/dsh-remote/payload/${packed.fileName}"`,
      { timeoutMs: OP_TIMEOUT_MS },
    )
  }
}
