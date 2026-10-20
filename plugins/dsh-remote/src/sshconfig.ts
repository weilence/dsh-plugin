import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import type { SshHostEntry, SshHostsResponse } from './shared'

/**
 * ~/.ssh/config 的只读扫描：给面板选择器提供「可连接的别名 + 配置里声明的
 * 端点摘要」。
 *
 * 只做展示：真正的连接参数永远由 ssh 自己解析配置得出，这里**不模拟** Match
 * 条件、通配 Host 段与默认值继承（`Host *` 的 User / Port 等不会体现在摘要里）。
 * 因此摘要标注为「配置声明值」，不是 ssh 的生效值。
 */

const MAX_INCLUDE_DEPTH = 8
const MAX_ERROR_CHARS = 300

/** 只把「单层字面量」模式当可连接别名：含通配 / 否定 / 字符类的段无法直接 ssh。 */
function isLiteralAlias(pattern: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(pattern)
}

/** 剥注释：`#` 在行首或空白后视为注释（ssh_config 的值里几乎不会出现 #）。 */
function stripComment(line: string): string {
  const match = /(^|\s)#/.exec(line)
  return match === null ? line : line.slice(0, match.index)
}

/** `Keyword value` / `Keyword=value`（大小写不敏感）。 */
function splitDirective(line: string): { keyword: string; value: string } | null {
  const trimmed = stripComment(line).trim()
  if (trimmed.length === 0) return null
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(trimmed)
  if (match === null) return null
  return { keyword: match[1].toLowerCase(), value: match[2].trim() }
}

function emptyEntry(alias: string): SshHostEntry {
  return { alias, hostname: null, user: null, port: null, identityFile: null, proxy: null }
}

/** 首值优先（ssh 的「首次取值」语义）：别名在多段里出现时，后段只补空缺。 */
function applyDirective(entry: SshHostEntry, keyword: string, value: string): void {
  if (value.length === 0) return
  switch (keyword) {
    case 'hostname':
      entry.hostname ??= value
      return
    case 'user':
      entry.user ??= value
      return
    case 'port': {
      if (entry.port !== null) return
      const port = Number.parseInt(value, 10)
      if (Number.isInteger(port) && port >= 1 && port <= 65535) entry.port = port
      return
    }
    case 'identityfile':
      entry.identityFile ??= value
      return
    case 'proxyjump':
    case 'proxycommand':
      entry.proxy ??= value
      return
    default:
      return
  }
}

/** 纯解析：不含 Include（调用方先展开）。按别名排序返回。 */
export function parseSshConfig(text: string): SshHostEntry[] {
  const byAlias = new Map<string, SshHostEntry>()
  /** 当前 Host 段覆盖的别名（小写）；Match 段与通配段把上下文清空。 */
  let block: string[] | null = null
  for (const line of text.split(/\r?\n/)) {
    const directive = splitDirective(line)
    if (directive === null) continue
    const { keyword, value } = directive
    if (keyword === 'host') {
      const aliases = value.split(/\s+/).filter((pattern) => isLiteralAlias(pattern))
      block = aliases.length === 0 ? null : aliases.map((alias) => alias.toLowerCase())
      for (const alias of aliases) {
        if (!byAlias.has(alias.toLowerCase())) byAlias.set(alias.toLowerCase(), emptyEntry(alias))
      }
      continue
    }
    if (keyword === 'match') {
      block = null
      continue
    }
    if (block === null) continue
    for (const alias of block) {
      const entry = byAlias.get(alias)
      if (entry !== undefined) applyDirective(entry, keyword, value)
    }
  }
  return [...byAlias.values()].sort((left, right) =>
    left.alias.localeCompare(right.alias, 'en', { sensitivity: 'base' }),
  )
}

/** Include 里的 ~ / %d / ${ENV}（相对路径按 ssh 语义落到 ~/.ssh）。 */
function expandIncludePath(pattern: string, sshDir: string): string {
  let path = pattern.replace(/^~(?=$|[\\/])/, sshDir)
  path = path.replace(/%d/g, homedir())
  path = path.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
    const value = process.env[name]
    return value === undefined ? match : value
  })
  return isAbsolute(path) ? path : join(sshDir, path)
}

/** glob → 正则（* / ? / [...]），用于 Include 的通配展开。 */
function globRegex(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') source += '.*'
    else if (char === '?') source += '.'
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index) {
        source += pattern.slice(index, end + 1)
        index = end
      } else {
        source += '\\['
      }
    } else source += char.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

async function includeFiles(pattern: string, sshDir: string): Promise<string[]> {
  const resolved = expandIncludePath(pattern, sshDir)
  if (!/[*?]/.test(resolved)) return [resolved]
  let names: string[]
  try {
    names = await readdir(dirname(resolved))
  } catch {
    return []
  }
  const match = globRegex(basename(resolved))
  return names
    .filter((name) => match.test(name))
    .sort()
    .map((name) => join(dirname(resolved), name))
}

/** 把 Include 就地展开成一份文本（近似 ssh 的「在同一位置插入」语义）。 */
async function inlineIncludes(
  text: string,
  sshDir: string,
  depth: number,
  seen: Set<string>,
  errors: string[],
): Promise<string> {
  if (depth > MAX_INCLUDE_DEPTH) {
    errors.push(`Include 嵌套超过 ${MAX_INCLUDE_DEPTH} 层`)
    return text
  }
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const directive = splitDirective(line)
    if (directive === null || directive.keyword !== 'include') {
      out.push(line)
      continue
    }
    for (const pattern of directive.value.split(/\s+/).filter((item) => item.length > 0)) {
      for (const file of await includeFiles(pattern, sshDir)) {
        if (seen.has(file)) {
          errors.push(`Include 循环：${file}`)
          continue
        }
        seen.add(file)
        try {
          const content = await readFile(file, 'utf8')
          out.push(await inlineIncludes(content, sshDir, depth + 1, seen, errors))
        } catch (error) {
          errors.push(
            `Include 读取失败：${file}（${error instanceof Error ? error.message : String(error)}）`,
          )
        }
      }
    }
  }
  return out.join('\n')
}

/**
 * 读取用户的 ssh 配置（默认 ~/.ssh/config）。缺失 → exists=false 的空清单；
 * 读取 / Include 出错 → 已解析出的部分照常返回，error 说明原因。
 */
export async function readSshConfig(configPath?: string): Promise<SshHostsResponse> {
  const sshDir = join(homedir(), '.ssh')
  const path = configPath ?? join(sshDir, 'config')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return {
      path,
      exists: false,
      hosts: [],
      error: missing ? null : `读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const errors: string[] = []
  const seen = new Set<string>([path])
  const combined = await inlineIncludes(text, sshDir, 0, seen, errors)
  const hosts = parseSshConfig(combined)
  return {
    path,
    exists: true,
    hosts,
    error: errors.length === 0 ? null : errors.join('；').slice(0, MAX_ERROR_CHARS),
  }
}
