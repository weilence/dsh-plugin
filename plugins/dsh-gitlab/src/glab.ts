import { spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { GlabStatusView } from './shared'

/** 输出捕获的头 / 尾保留字符数；两者之和即单流内存上限。 */
export const OUTPUT_HEAD_CHARS = 16_000
export const OUTPUT_TAIL_CHARS = 16_000

/** 有界输出捕获：先填头部，溢出后滚动保留尾部，truncated 标注中间有丢失。 */
export class BoundedCapture {
  private head = ''
  private tail = ''
  private total = 0

  push(chunk: string): void {
    this.total += chunk.length
    const headRoom = OUTPUT_HEAD_CHARS - this.head.length
    if (headRoom > 0) {
      this.head += chunk.slice(0, headRoom)
      chunk = chunk.slice(headRoom)
    }
    if (chunk === '') return
    this.tail = (this.tail + chunk).slice(-OUTPUT_TAIL_CHARS)
  }

  get truncated(): boolean {
    return this.total > this.head.length + this.tail.length
  }

  text(): string {
    return this.head + this.tail
  }
}

export interface GlabRunRequest {
  /** glab 可执行文件路径（探测结果或用户配置 glabPath）。 */
  glabPath: string
  args: string[]
  cwd?: string
  /** 超时毫秒数；到点终止进程，返回已捕获输出并置 timedOut。 */
  timeoutMs: number
  /** 子进程完整环境（调用方已并入 GITLAB_HOST）。 */
  env: NodeJS.ProcessEnv
}

export interface GlabRunResult {
  /** 被信号终止（超时 / 外部取消）时为 null。 */
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

/**
 * spawn glab 一次调用：argv 直传不经 shell，输出有界（头尾保留）。
 * 超时返回部分产物（timedOut）；调用方取消（signal）原样抛出 reason，宿主管道按其落 ABORTED。
 */
export function runGlab(request: GlabRunRequest, signal?: AbortSignal): Promise<GlabRunResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(request.glabPath, request.args, {
        cwd: request.cwd,
        env: request.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    const startedAt = Date.now()
    const stdout = new BoundedCapture()
    const stderr = new BoundedCapture()
    // chunk 边界可能切开多字节字符：StringDecoder 跨 chunk 拼接（残留 ≤3 字节）。
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')
    let timedOut = false
    let settled = false

    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const finish = (exitCode: number | null) => {
      if (settled) return
      settle()
      resolve({
        exitCode,
        stdout: stdout.text() + outDecoder.end(),
        stderr: stderr.text() + errDecoder.end(),
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    }
    const fail = (error: unknown) => {
      if (settled) return
      settle()
      reject(error)
    }

    const timer = setTimeout(() => {
      // 进程已退出（边界竞争）就不标 timedOut。
      if (child.exitCode !== null || child.signalCode !== null) return
      timedOut = true
      terminate()
    }, request.timeoutMs)

    // shell 型命令会留下继承管道写端的孤儿子进程（如 sh 的 sleep）：只 kill 主
    // 进程不够，close 要等 stdio 全关——主动销毁流让 close 立即可达。
    const terminate = (): void => {
      child.kill('SIGKILL')
      child.stdout?.destroy()
      child.stderr?.destroy()
    }

    const onAbort = () => {
      terminate()
      fail(signal?.reason instanceof Error ? signal.reason : new Error('已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(outDecoder.write(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(errDecoder.write(chunk)))
    child.on('error', (error: NodeJS.ErrnoException) => {
      fail(new Error(`无法启动 glab（${request.glabPath}）：${error.message}`))
    })
    child.on('close', (code) => finish(code))
  })
}

/** argv 的展示形态：含空白或单引号的项按 POSIX 惯例单引号包裹（仅用于产物展示，不参与执行）。 */
export function displayCommand(args: string[]): string {
  return args.map((arg) => (/[\s']/.test(arg) ? `'${arg.replaceAll("'", `'\\''`)}'` : arg)).join(' ')
}

export interface GlabResolution {
  path: string
  /** 裸命令名（交给 spawn 按 PATH 解析）时为 true，跳过存在性检查。 */
  bare: boolean
}

/**
 * glab 解析候选（有序、去重）：显式 glabPath 配置 → 平台惯例位置 → PATH 逐目录扫描 →
 * 裸命令名兜底。宿主是 GUI 进程，PATH 常不含 homebrew，惯例位置与用户配置是主路径。
 */
export function glabCandidates(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): GlabResolution[] {
  // 分隔符跟随请求平台：node:path 的 join/delimiter 跟随宿主平台，Windows 宿主上
  // 解析 darwin/linux 语义会拼出反斜杠路径（候选要回显给用户）。惯例位置是固定的
  // POSIX 路径，恒用 / 拼接；PATH 条目按请求平台的分隔符拆分与拼接。
  const win32 = platform === 'win32'
  const exe = win32 ? 'glab.exe' : 'glab'
  const joinExe = (dir: string, sep: '/' | '\\'): string => `${dir.replace(/[\\/]+$/, '')}${sep}${exe}`
  const seen = new Set<string>()
  const result: GlabResolution[] = []
  const add = (entry: GlabResolution): void => {
    if (seen.has(entry.path)) return
    seen.add(entry.path)
    result.push(entry)
  }
  if (configured !== undefined && configured.trim() !== '') add({ path: configured.trim(), bare: false })
  for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']) {
    add({ path: joinExe(dir, '/'), bare: false })
  }
  for (const dir of (env.PATH ?? '').split(win32 ? ';' : ':')) {
    const trimmed = dir.trim()
    if (trimmed !== '') add({ path: joinExe(trimmed, win32 ? '\\' : '/'), bare: false })
  }
  add({ path: exe, bare: true })
  return result
}

/** glab 二进制探测：第一个可执行的候选 + `--version` 首行；全部落空返回 null path 与指引。 */
export async function resolveGlabStatus(
  configured: string | undefined,
  options: {
    env: NodeJS.ProcessEnv
    platform: NodeJS.Platform
    run: typeof runGlab
  },
): Promise<GlabStatusView> {
  const executable = glabCandidates(configured, options.env, options.platform).find(
    (candidate) => candidate.bare || isExecutable(candidate.path),
  )
  if (executable === undefined) {
    return {
      path: null,
      error:
        '未在惯例位置与 PATH 中找到 glab：可先安装（macOS `brew install glab`），或在本插件配置里用 glabPath 指定路径',
    }
  }
  const probe = await options.run({
    glabPath: executable.path,
    args: ['--version'],
    timeoutMs: 5_000,
    env: options.env,
  })
  const firstLine = probe.stdout.split('\n')[0]?.trim() ?? ''
  if (probe.exitCode !== 0 || firstLine === '') {
    return {
      path: executable.path,
      error: `glab --version 探测失败：${(probe.stderr || probe.stdout).trim()}`,
    }
  }
  return { path: executable.path, version: firstLine }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
