import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * 本机子进程输出的解码与 Windows 命令解析。
 *
 * 背景：本仓库本地 spawn 一律管道 + windowsHide（无控制台），发射方按系统
 * OEM 代码页写字节——cmd.exe 的本地化失败文本（找不到命令 / 拒绝访问等）在
 * zh-CN 是 GBK 字节，按 UTF-8 解即乱码；而 pnpm / git / ssh / tar 是 Node
 * 应用或英文发射器，写管道的是 UTF-8 / ASCII。因此解码策略 = UTF-8 优先、
 * 仅当解码结果出现 U+FFFD 替换符（非法 UTF-8 序列的铁证）才按代码页回退：
 * 命令没起来时工具零输出、不存在混流；起来了输出必是 UTF-8，不会被误转。
 * 回退仅 win32 生效：Unix 上各工具按环境 locale 发射，现实目标全是 UTF-8，
 * 病态的非 UTF-8 locale 环境按原样展示（fail as-is，不猜）。
 */

/** Windows 控制台代码页 → WHATWG TextDecoder 标签（Node / Electron 全量 ICU 内建）。
 *  OEM 西文码页（437 / 850 / 852 / 857 / 858）不在 WHATWG 标签内，按最近似的
 *  windows-125x 近似；未知代码页映射不到就保持 UTF-8 原样（不猜）。 */
const CODEPAGE_LABELS: Record<number, string> = {
  936: 'gbk',
  54936: 'gb18030',
  950: 'big5',
  932: 'shift_jis',
  949: 'euc-kr',
  874: 'windows-874',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  866: 'ibm866',
  20866: 'koi8-r',
  21866: 'koi8-u',
  437: 'windows-1252',
  850: 'windows-1252',
  852: 'windows-1250',
  857: 'windows-1254',
  858: 'windows-1252',
}

/** 65001 本身就是 UTF-8，与「映射不到」同归 null——都走 UTF-8 原样。 */
export function codepageLabel(codepage: number): string | null {
  if (codepage === 65001) return null
  return CODEPAGE_LABELS[codepage] ?? null
}

/** chcp 输出解析：标签文案本地化，数字是 ASCII（'活动代码页: 936' / 'Active code page: 65001'）。 */
export function parseCodepageOutput(text: string): number | null {
  const match = /(\d{1,6})\s*$/.exec(text.trim())
  if (match === null) return null
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

let cachedCodepage: Promise<number | null> | undefined

/** 系统控制台 OEM 代码页（chcp 现查一次，进程内缓存 Promise——并发调用共享
 *  同一次查询；宿主 spawn 无控制台，发射方用的就是这个默认值，不随会话 chcp
 *  改动）。查询失败回 null。 */
export function windowsConsoleCodepage(): Promise<number | null> {
  cachedCodepage ??= new Promise<number | null>((resolve) => {
    // chcp.com 是 PE 映像，可直接 spawn（不经 shell）。
    const child = spawn('chcp.com', [], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('latin1')
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => resolve(code === 0 ? parseCodepageOutput(stdout) : null))
  })
  return cachedCodepage
}

/** 本机子进程输出解码：UTF-8 优先；仅 win32 且解码出现 U+FFFD 时按代码页回退。 */
export function decodeLocalOutput(
  chunks: readonly Buffer[],
  win32: boolean,
  codepage: number | null,
): string {
  const buffer = Buffer.concat(chunks)
  const utf8 = buffer.toString('utf8')
  if (!win32 || codepage === null || !utf8.includes('\uFFFD')) return utf8
  const label = codepageLabel(codepage)
  if (label === null) return utf8
  try {
    return new TextDecoder(label).decode(buffer)
  } catch {
    return utf8
  }
}

const PNPM_EXTENSIONS = ['.exe', '.cmd', '.bat'] as const

/** PATH 目录 × 扩展名顺序解析（目录优先于扩展名，与 PATH 语义一致；固定扩展名
 *  顺序不读 PATHEXT，保持确定性）。 */
export function resolveWindowsCommand(
  name: string,
  dirs: readonly string[],
  extensions: readonly string[],
  exists: (path: string) => boolean,
): string | null {
  for (const dir of dirs) {
    if (dir.trim() === '') continue
    for (const extension of extensions) {
      const candidate = `${dir}\\${name}${extension}`
      if (exists(candidate)) return candidate
    }
  }
  return null
}

/** 宿主进程 PATH 上的 pnpm 绝对路径；找不到回 null（调用方显式报错）。 */
export function resolveWindowsPnpm(
  envPath: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (envPath === undefined || envPath === '') return null
  return resolveWindowsCommand('pnpm', envPath.split(';'), PNPM_EXTENSIONS, exists)
}
