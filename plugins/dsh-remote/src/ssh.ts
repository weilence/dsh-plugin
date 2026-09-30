import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { errMsg } from '@dsh-plugins/shared'
import type { SshErrorKind } from './shared'

/** 一次远端命令的结果（非 0 退出码不抛异常，由调用方决定语义）。 */
export interface SshResult {
  code: number
  stdout: string
  stderr: string
}

/** 连接级失败（认证 / 不可达 / 超时 / 本机缺工具）；命令级失败走 code。 */
export class SshFailure extends Error {
  constructor(
    readonly kind: SshErrorKind,
    message: string,
  ) {
    super(message)
  }
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

export type SshExec = (alias: string, command: string, options?: SshExecOptions) => Promise<SshResult>

function classify(code: number | null, stderr: string, spawnError?: NodeJS.ErrnoException): SshFailure {
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
      text.includes('permission denied') ||
      text.includes('no such identity') ||
      text.includes('authentication')
    ) {
      return new SshFailure(
        'auth-failed',
        'SSH 认证失败：检查 ~/.ssh/config 别名与密钥（BatchMode 下无法交互输入密码）',
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
    stderr.trim().split(/\r?\n/).slice(-3).join(' ') || `退出码 ${code}`,
  )
}

// 宿主侧受信代码直接 spawn（不经模型沙箱），认证完全复用用户 OpenSSH 配置。
/** ssh 命令执行：连接级失败抛 SshFailure，命令级失败原样返回 code/stderr。 */
export const sshExec: SshExec = (alias, command, options) =>
  new Promise<SshResult>((resolve, reject) => {
    const child = spawn('ssh', ['-o', 'BatchMode=yes', alias, loginWrapped(command)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(
        new SshFailure(
          'timeout',
          `远端命令超时（${options?.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms）：${command.slice(0, 80)}`,
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
      reject(classify(null, stderr, error))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === null) return // 已由 error / timeout 路径结算
      if (code === 255) {
        reject(classify(code, stderr))
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
/** 本地端口转发子进程的抽象句柄（engine 测试注入 fake 用）。 */
export interface ForwardHandle {
  kill(): void
  /** 进程意外退出的观察回调（转发中断 → 连接转 error）。 */
  onExit(callback: () => void): void
  /** 子进程 pid（转发租约落盘用；spawn 未完成时为 null）。 */
  pid: number | null
}

/** 起 `ssh -N -L` 本地转发；不等待退出，返回句柄由调用方持有。 */
export function startSshForward(alias: string, localPort: number, remotePort: number): ForwardHandle {
  const child: ChildProcess = spawn(
    'ssh',
    ['-o', 'BatchMode=yes', '-N', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, alias],
    { stdio: 'ignore', windowsHide: true },
  )
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
export function tarOverSsh(
  alias: string,
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
        '-o',
        'BatchMode=yes',
        alias,
        loginWrapped(`mkdir -p ${shQuote(remoteRoot)} && tar -C ${shQuote(remoteRoot)} -xf -`),
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
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
      settle(classify(null, stderr, error))
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
