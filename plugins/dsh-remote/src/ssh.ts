import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { errMsg } from '@dsh-plugins/shared'
import type { ConnectionTarget, SshErrorKind } from './shared'

/** 一次远端命令的结果（非 0 退出码不抛异常，由调用方决定语义）。 */
export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

/** 连接级失败（认证 / 主机密钥 / 不可达 / 超时 / 本机缺工具）；命令级失败走 code。 */
export class SshFailure extends Error {
  constructor(
    readonly kind: SshErrorKind,
    message: string,
    /** 完整输出详情（面板「查看完整」弹窗的数据源）；message 是单行摘要。 */
    readonly detail?: string,
  ) {
    super(message)
  }
}

/** 一次 ssh 调用的目标：连接声明 + 当前可用的口令（宿主内存里的或已保存的）。 */
export interface SshTarget {
  target: ConnectionTarget
  /** 密码或私钥口令；null = 没有可用口令（未加密私钥 / 别名交给配置）。 */
  secret: string | null
}

/** 本机 ssh 客户端的横幅行（如 OpenSSH 10 对无 post-quantum KEX 服务端的提示，
 *  首尾皆 **）：混在 stderr 里但不是远端命令的输出——报错时剔除，避免顶掉真实原因。 */
const SSH_CLIENT_BANNER = /^\*\*.*\*\*$/

/** 错误详情全文的字符上限：超出保尾部（报错根因通常在末尾）并标明截去的量。 */
const DETAIL_CAP = 16 * 1024

/** 两路输出合并为干净行序列：去空行与 ssh 客户端横幅噪声。 */
function cleanLines(stdout: string, stderr: string): string[] {
  return [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)]
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !SSH_CLIENT_BANNER.test(line))
}

/** 两路输出的单行摘要（错误行 / toast 用）：末 3 行拼接，300 字符封顶。 */
export function summarizeOutput(stdout: string, stderr: string): string {
  return cleanLines(stdout, stderr).slice(-3).join(' ').slice(0, 300)
}

/** 两路输出的完整详情（「查看完整」弹窗用）：保行结构，超长截头保尾。 */
export function mergedOutput(stdout: string, stderr: string): string {
  const text = cleanLines(stdout, stderr).join('\n')
  if (text.length <= DETAIL_CAP) return text
  return `…（输出超长，已截去前 ${text.length - DETAIL_CAP} 字符）\n${text.slice(-DETAIL_CAP)}`
}

/** 单引号 shell 转义（远端命令内嵌时使用）。 */
export function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`
}

// 统一经 `bash -lc` 登录 shell 包装：非交互 ssh 不读用户 profile，nvm 装的
// node / npm 全局 bin 会不在 PATH 上——这是 npm 全局 bin 不可见的常见根因。
export function loginWrapped(command: string): string {
  return `bash -lc ${shQuote(command)}`
}

const DEFAULT_TIMEOUT_MS = 30_000
const OUTPUT_CAP = 200_000

export interface SshExecOptions {
  /** 写入远端命令 stdin 的内容（patch 文本或 tgz 二进制，通道均为原始字节）。 */
  stdin?: string | Uint8Array
  /** 超时毫秒数（默认 30s）。 */
  timeoutMs?: number
}

export type SshExec = (target: SshTarget, command: string, options?: SshExecOptions) => Promise<SshResult>

// ---------------------------------------------------------------------------
// 口令通道（SSH_ASKPASS）
//
// 密码与私钥口令都必须在 ssh 的「提示」路径里递进去，而 BatchMode 会跳过该
// 路径，所以带口令的调用不能设 BatchMode（见 buildSshInvocation）。
//
// Windows 的 CreateProcess 不能把 .cmd / 脚本当 SSH_ASKPASS（实测 EINVAL），
// 所以 hook 用 Node 的 --require 预载执行：SSH_ASKPASS 指向宿主自身的可执行
// 文件（Electron 宿主用 ELECTRON_RUN_AS_NODE=1 以 Node 模式运行），NODE_OPTIONS
// 预载 hook，口令经环境变量传入、由 hook 原样写到 stdout。首次使用时做一次
// 自检——机制失效时给出明确错误，而不是让 ssh 报一个含混的认证失败。
// ---------------------------------------------------------------------------

const ASKPASS_DIR = 'dsh-remote'
const ASKPASS_FILE = 'askpass.cjs'
const ASKPASS_SECRET_ENV = 'DSH_REMOTE_SSH_SECRET'
const ASKPASS_PROBE_TIMEOUT_MS = 10_000
const ASKPASS_HOOK = [
  '// 由 ssh 的 SSH_ASKPASS 调用：宿主把口令放进环境变量，这里原样写到 stdout。',
  'process.stdout.write(String(process.env.DSH_REMOTE_SSH_SECRET ?? ""))',
  'process.exit(0)',
  '',
].join('\n')

/** 口令通道：给 ssh 子进程造环境，并保证 hook 与自检就绪。 */
export interface Askpass {
  /** 与口令一起传给 ssh 子进程的环境变量。 */
  env(secret: string): NodeJS.ProcessEnv
  /** 写 hook（缺失 / 内容变更时）+ 一次性自检。 */
  ensure(): Promise<void>
}

export function createAskpass(homeDir: string): Askpass {
  const hookPath = join(homeDir, ASKPASS_DIR, ASKPASS_FILE)
  const env = (secret: string): NodeJS.ProcessEnv => ({
    SSH_ASKPASS: process.execPath,
    // force：非 tty 也走 askpass（GUI 宿主没有终端可问）
    SSH_ASKPASS_REQUIRE: 'force',
    // 宿主是 Electron 时 process.execPath 是应用本身，以 Node 模式运行它；
    // 纯 node 宿主下该变量无副作用
    ELECTRON_RUN_AS_NODE: '1',
    // NODE_OPTIONS 的解析器支持双引号；正斜杠避免反斜杠被当转义
    NODE_OPTIONS: `--require "${hookPath.replace(/\\/g, '/')}"`,
    [ASKPASS_SECRET_ENV]: secret,
  })
  let ready: Promise<void> | null = null

  const verify = async (): Promise<void> => {
    const sentinel = randomBytes(12).toString('hex')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['dsh-remote-askpass-probe'], {
        env: { ...process.env, ...env(sentinel) },
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
      let stdout = ''
      let settled = false
      const finish = (error?: SshFailure): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error === undefined) resolve()
        else reject(error)
      }
      const timer = setTimeout(() => {
        child.kill()
        finish(new SshFailure('unknown', '口令通道自检超时：宿主可执行文件未能以 Node 模式运行预载 hook'))
      }, ASKPASS_PROBE_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(new SshFailure('unknown', `口令通道无法启动（${process.execPath}）：${error.message}`))
      })
      child.on('close', () => {
        finish(
          stdout.trim() === sentinel
            ? undefined
            : new SshFailure(
                'unknown',
                '口令通道自检失败：宿主可执行文件未回传口令（SSH_ASKPASS 预载 hook 未生效）',
              ),
        )
      })
    })
  }

  const prepare = async (): Promise<void> => {
    await mkdir(join(homeDir, ASKPASS_DIR), { recursive: true, mode: 0o700 })
    let current: string | null = null
    try {
      current = await readFile(hookPath, 'utf8')
    } catch {
      // 首次使用：下面写
    }
    if (current !== ASKPASS_HOOK) {
      const temporary = `${hookPath}.tmp-${randomBytes(4).toString('hex')}`
      await writeFile(temporary, ASKPASS_HOOK, { encoding: 'utf8', mode: 0o600 })
      await rename(temporary, hookPath)
      await chmod(hookPath, 0o600).catch(() => {})
    }
    await verify()
  }

  return {
    env,
    ensure(): Promise<void> {
      ready ??= prepare().catch((error: unknown) => {
        // 自检失败不缓存：修好环境（换宿主 / 权限）后下一次操作可重试
        ready = null
        throw error
      })
      return ready
    },
  }
}

// ---------------------------------------------------------------------------
// 调用参数矩阵
//
// | 目标                          | BatchMode | 其他                                   |
// | ----------------------------- | --------- | -------------------------------------- |
// | alias                         | yes       | 认证完全交给 ~/.ssh/config             |
// | direct + key（无口令）        | yes       | -i + IdentitiesOnly + publickey        |
// | direct + key（有口令）        | no        | + NumberOfPasswordPrompts=1 + askpass  |
// | direct + password             | no        | PubkeyAuthentication=no + askpass      |
//
// 「有口令要递，就不能让 ssh 进入不提问模式；没口令可递，就用 BatchMode 保证
//  快速失败而不是等一个永远不存在的终端。」
// ---------------------------------------------------------------------------

export interface SshInvocation {
  args: string[]
  /** null = 不需要口令通道；否则与 process.env 合并后交给 ssh。 */
  env: NodeJS.ProcessEnv | null
}

/** 直连统一的主机密钥策略：未知主机自动记录（TOFU），密钥变更硬失败。 */
const STRICT_HOST_KEY = 'StrictHostKeyChecking=accept-new'

export function buildSshInvocation(
  target: SshTarget,
  askpass: Askpass,
  extra: readonly string[] = [],
): SshInvocation {
  const connection = target.target
  const args: string[] = []
  if (connection.kind === 'alias') {
    args.push('-o', 'BatchMode=yes', ...extra, '--', connection.alias)
    return { args, env: null }
  }
  if (connection.auth === 'password' && target.secret === null) {
    // 防错分支：界面上密码登录必须带口令；走到这里说明状态过期（如宿主重启
    // 后连接库里的口令已不在内存），显式报错而不是让 ssh 报认证失败
    throw new SshFailure('auth-failed', '该连接需要登录密码：请在面板重新输入密码')
  }
  args.push('-o', STRICT_HOST_KEY)
  if (connection.port !== null) args.push('-p', String(connection.port))
  if (connection.user !== null) args.push('-l', connection.user)
  if (connection.auth === 'key') {
    args.push(
      '-i',
      connection.identityFile ?? '',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'PreferredAuthentications=publickey',
    )
  } else {
    args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive')
  }
  const secret = target.secret
  if (secret === null) {
    args.push('-o', 'BatchMode=yes')
  } else {
    // 重试压到一次：同一个口令喂三遍既慢又容易触发服务端失败计数；私钥口令
    // 的加载循环同样受该值约束
    args.push('-o', 'NumberOfPasswordPrompts=1')
  }
  args.push(...extra, '--', connection.host)
  return { args, env: secret === null ? null : askpass.env(secret) }
}

/** 把 ssh 的退出码 / stderr 归一为可操作失败分类（host 级错误与命令级错误共用）。 */
export function classifySshFailure(
  code: number | null,
  stderr: string,
  spawnError?: NodeJS.ErrnoException,
): SshFailure {
  if (spawnError?.code === 'ENOENT') {
    return new SshFailure(
      'local-tool-missing',
      '本机未找到 ssh 可执行文件：请安装 OpenSSH 客户端（Windows 的「可选功能 → OpenSSH 客户端」）并加入 PATH',
    )
  }
  if (spawnError !== undefined) {
    return new SshFailure('unknown', `无法启动 ssh：${spawnError.message}`)
  }
  const text = stderr.toLowerCase()
  if (code === 255) {
    if (
      text.includes('host key verification failed') ||
      text.includes('remote host identification has changed') ||
      (text.includes('host key for') && text.includes('has changed'))
    ) {
      return new SshFailure(
        'host-key',
        '主机密钥校验失败：远端密钥与 known_hosts 记录不一致。若确属远端重装，请先在终端用 ssh 连一次核对并更新 known_hosts——本插件不自动清除记录',
        mergedOutput('', stderr),
      )
    }
    if (
      text.includes('permission denied') ||
      text.includes('no such identity') ||
      text.includes('authentication')
    ) {
      return new SshFailure(
        'auth-failed',
        'SSH 认证失败：检查用户名、密码、密钥文件与私钥口令；别名连接需在 ~/.ssh/config 侧配好免交互登录（BatchMode 下不会询问密码）',
      )
    }
    if (
      text.includes('could not resolve hostname') ||
      text.includes('connection refused') ||
      text.includes('connection timed out') ||
      text.includes('timed out') ||
      text.includes('no route to host') ||
      text.includes('connection reset') ||
      text.includes('unreachable')
    ) {
      return new SshFailure('unreachable', `无法连接远端：${stderr.trim().split(/\r?\n/)[0] || '网络不可达'}`)
    }
  }
  return new SshFailure(
    'remote-cmd-failed',
    // 摘要走 cleanLines：剔除本机 ssh 客户端横幅，避免顶掉真实原因
    summarizeOutput('', stderr) || `退出码 ${code}`,
    mergedOutput('', stderr),
  )
}

/** 密钥文件带口令却没填：认证失败时补一句可操作的提示（BatchMode 下 ssh 不会
 *  提问，只会给出笼统的 Permission denied）。 */
function withKeyPassphraseHint(error: unknown, target: SshTarget): unknown {
  if (!(error instanceof SshFailure) || error.kind !== 'auth-failed') return error
  const connection = target.target
  if (connection.kind !== 'direct' || connection.auth !== 'key' || target.secret !== null) return error
  return new SshFailure(error.kind, `${error.message}（若该私钥设了口令，请填写「私钥口令」）`, error.detail)
}

function sshEnv(env: NodeJS.ProcessEnv | null): NodeJS.ProcessEnv {
  return env === null ? process.env : { ...process.env, ...env }
}

/** 单次 ssh 命令：连接级失败抛 SshFailure，命令级失败原样返回 code/stderr。 */
function spawnSsh(
  args: string[],
  env: NodeJS.ProcessEnv | null,
  options?: SshExecOptions,
): Promise<SshResult> {
  return new Promise<SshResult>((resolve, reject) => {
    const child = spawn('ssh', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: sshEnv(env),
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new SshFailure(
          'timeout',
          `远端命令超时（${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）：${args.at(-1)?.slice(0, 80) ?? ''}`,
        ),
      )
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8')
    })
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      reject(classifySshFailure(null, stderr, error))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === null) return // 已由 error / timeout 路径结算
      if (code === 255) {
        reject(classifySshFailure(code, stderr))
        return
      }
      resolve({ code, stdout, stderr })
    })
    if (options?.stdin !== undefined) {
      child.stdin?.write(options.stdin)
      child.stdin?.end()
    } else {
      child.stdin?.end()
    }
  })
}

/** 本地端口转发子进程的抽象句柄（engine 测试注入 fake 用）。 */
export interface ForwardHandle {
  kill(): void
  /** 进程意外退出的观察回调（转发中断 → 连接转 error）。 */
  onExit(callback: () => void): void
  /** 子进程 pid（转发租约落盘用；spawn 未完成时为 null）。 */
  pid: number | null
}

function spawnForward(invocation: SshInvocation): ForwardHandle {
  const child: ChildProcess = spawn('ssh', invocation.args, {
    stdio: 'ignore',
    windowsHide: true,
    env: sshEnv(invocation.env),
  })
  const listeners = new Set<() => void>()
  child.on('exit', () => {
    for (const listener of listeners) listener()
  })
  return {
    kill() {
      child.kill()
    },
    onExit(callback) {
      listeners.add(callback)
    },
    pid: child.pid ?? null,
  }
}

/** 核验后杀掉租约记录的遗留转发进程。直接信 pid 会误杀已复用到无关进程的 pid：
 *  先读命令行，确认它仍是本插件形态的 `ssh -N -L 127.0.0.1:<port>:`（Windows 的
 *  tasklist 只有映像名，退化为只认 ssh 映像）；核验工具启动失败时不杀（宁泄漏
 *  不误杀，租约留待下次清扫）。 */
export async function killOrphanForward(
  pid: number,
  localPort: number,
): Promise<'killed' | 'dead' | 'unverified'> {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead'
  const described = await describeProcess(pid)
  if (described === undefined) return 'unverified'
  if (described === null) return 'dead'
  const tokens = described.command.trim().split(/\s+/)
  const isSsh = tokens.some((token) => /(?:^|[\\/])(?:ssh|ssh\.exe)$/i.test(token))
  const ours = described.fullArgs
    ? isSsh && described.command.includes('-N') && described.command.includes(`127.0.0.1:${localPort}:`)
    : isSsh
  if (!ours) return 'dead'
  process.kill(pid)
  return 'killed'
}

/** 进程概况：undefined = 核验工具缺失；null = 进程已不存在。 */
async function describeProcess(
  pid: number,
): Promise<{ command: string; fullArgs: boolean } | null | undefined> {
  const run = (file: string, args: string[]): Promise<{ stdout: string; code: number | null } | undefined> =>
    new Promise((resolve) => {
      const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      let stdout = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8')
      })
      child.on('error', () => resolve(undefined))
      child.on('close', (code) => resolve({ stdout, code }))
    })
  if (process.platform === 'win32') {
    const result = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
    if (result === undefined) return undefined
    const first = (result.stdout.split(/\r?\n/)[0] ?? '').trim()
    if (first === '' || /^INFO:/i.test(first)) return null
    return { command: first.replace(/"/g, ''), fullArgs: false }
  }
  const result = await run('ps', ['-p', String(pid), '-o', 'command='])
  if (result === undefined) return undefined
  if (result.code !== 0 || result.stdout.trim() === '') return null
  return { command: result.stdout, fullArgs: true }
}

/** tar-over-ssh 单通道推送：本地 tar 打包的 stdout 直接写入远端 tar 解包的 stdin。
 *  names 指定时只打包根内的这些条目（skills 按勾选推送），缺省整根。 */
function tarOverSsh(
  invocation: SshInvocation,
  localRoot: string,
  remoteRoot: string,
  names?: readonly string[],
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tar = spawn('tar', ['-C', localRoot, '-cf', '-', ...(names === undefined ? ['.'] : [...names])], {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    const ssh = spawn(
      'ssh',
      [
        ...invocation.args,
        loginWrapped(`mkdir -p ${shQuote(remoteRoot)} && tar -C ${shQuote(remoteRoot)} -xf -`),
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true, env: sshEnv(invocation.env) },
    )
    let stderr = ''
    let settled = false
    const settle = (error: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolve()
      else if (error instanceof SshFailure) reject(error)
      else reject(new SshFailure('remote-cmd-failed', errMsg(error)))
    }
    const timer = setTimeout(() => {
      tar.kill()
      ssh.kill()
      settle(new SshFailure('timeout', 'tar 同步超时（120s）'))
    }, 120_000)
    tar.on('error', (error: NodeJS.ErrnoException) => {
      ssh.kill()
      settle(
        error.code === 'ENOENT'
          ? new SshFailure(
              'local-tool-missing',
              '本机未找到 tar：Windows 10+ 自带 bsdtar，请确认其在 PATH 上',
            )
          : error,
      )
    })
    ssh.on('error', (error: NodeJS.ErrnoException) => {
      tar.kill()
      settle(classifySshFailure(null, stderr, error))
    })
    ssh.on('close', (code) => {
      if (code !== 0 && code !== null)
        settle(new SshFailure('remote-cmd-failed', `远端解包失败（退出码 ${code}）`))
      else if (tar.exitCode === null || tar.exitCode === 0) settle(undefined)
    })
    tar.on('close', (code) => {
      if (code !== 0 && code !== null)
        settle(new SshFailure('remote-cmd-failed', `本地打包失败（退出码 ${code}）`))
      ssh.stdin?.end()
    })
    ;(tar.stdout as Readable).pipe(ssh.stdin!)
  })
}

/** 引擎的外部 ssh 面：所有调用都按「连接目标 + 当前口令」组装参数与环境。 */
export interface SshTransport {
  exec: SshExec
  startForward(target: SshTarget, localPort: number, remotePort: number): Promise<ForwardHandle>
  pushTar(target: SshTarget, localRoot: string, remoteRoot: string, names?: readonly string[]): Promise<void>
}

/** 生产 transport：宿主侧受信代码直接 spawn，认证完全复用 OpenSSH 配置 + 口令通道。 */
export function createSshTransport(homeDir: string): SshTransport {
  const askpass = createAskpass(homeDir)
  return {
    async exec(target, command, options) {
      const invocation = buildSshInvocation(target, askpass)
      if (invocation.env !== null) await askpass.ensure()
      try {
        return await spawnSsh([...invocation.args, loginWrapped(command)], invocation.env, options)
      } catch (error) {
        throw withKeyPassphraseHint(error, target)
      }
    },
    async startForward(target, localPort, remotePort) {
      const invocation = buildSshInvocation(target, askpass, [
        '-N',
        '-L',
        `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
      ])
      if (invocation.env !== null) await askpass.ensure()
      return spawnForward(invocation)
    },
    async pushTar(target, localRoot, remoteRoot, names) {
      const invocation = buildSshInvocation(target, askpass)
      if (invocation.env !== null) await askpass.ensure()
      return tarOverSsh(invocation, localRoot, remoteRoot, names)
    },
  }
}
