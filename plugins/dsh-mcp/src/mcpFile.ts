import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { errMsg } from '@dsh-plugins/shared'
import type { McpConfigDraft, McpEffectiveConfig, McpTransport } from './shared'
import { SERVER_NAME_PATTERN } from './shared'

/**
 * `.mcp.json` 文件方言：标准 MCP JSON（`mcpServers` 包装；缺包装时接受
 * 「名称 → 配置」直接映射）。单台服务器条目键集与标准惯例一致——`type`
 * 承载传输形态（stdio 可省略，按 command / url 推断），`disabled` 是本
 * 插件的行级停用扩展键，其余未知键身份保留。JSON 无注释可保，格式化统
 * 一为两空格缩进；round-trip 保留的是键集与键序，不是字面排版。
 */

/** 标准侧已知键（文件条目对象上的键；与 mcp-client Config 侧键名不同源）。 */
const STANDARD_KEYS = new Set([
  'type',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
  'disabled',
])

/** 顶层结构错误（errMsg 过线，浏览器按 {text} 原样展示）。 */
export class FileParseError extends Error {}

/** 文件不存在时返回 null，其余 IO 错误照抛。 */
export async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** tmp + rename 原子落盘（写一半不留半个文件）。 */
export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

/** 文件内容版本：内容哈希（文件不存在为 null）——乐观并发的比对基准。 */
export function revisionOf(text: string | null): string | null {
  if (text === null) return null
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/** 一份解析后的 .mcp.json：原始条目全部保留（写回时身份不变），映射结
 *  果与不合法原因分开存放，供列表与挂载 diff 各取所需。 */
export interface McpFileState {
  /** 顶层除 mcpServers 外的键（写回时身份保留）。 */
  rootExtras: Record<string, unknown>
  /** 键 → 原始条目对象（含不合法条目；键序即文件序）。 */
  entries: Map<string, Record<string, unknown>>
  /** 合法条目的映射结果（mcp-client Config 形态，含 serverName）。 */
  valid: Map<string, { config: McpEffectiveConfig; disabled: boolean }>
  /** 不合法条目的原因。 */
  invalid: Map<string, string>
}

/** 空文件状态（文件不存在时使用）。 */
export function emptyFileState(): McpFileState {
  return { rootExtras: {}, entries: new Map(), valid: new Map(), invalid: new Map() }
}

function fail(message: string): never {
  throw new FileParseError(message)
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringRecord(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined
  const source = asObject(value)
  if (source === undefined) fail(`${label} 必须是字符串映射`)
  const record: Record<string, string> = {}
  for (const [key, item] of Object.entries(source)) {
    if (typeof item !== 'string') fail(`${label}["${key}"] 必须是字符串`)
    record[key] = item
  }
  return record
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${label} 必须是字符串`)
  return value.length > 0 ? value : undefined
}

/** 按 type（缺省按 command / url 推断）归一到两种传输形态。 */
function transportOf(value: Record<string, unknown>): McpTransport | undefined {
  const type = value.type
  if (type === 'stdio') return 'stdio'
  if (type === 'streamable-http' || type === 'http') return 'streamable-http'
  // sse 已废弃但语义明确：按 streamable-http 接入。
  if (type === 'sse') return 'streamable-http'
  if (type === undefined) {
    if (value.command !== undefined) return 'stdio'
    if (value.url !== undefined) return 'streamable-http'
  }
  return undefined
}

/** 单个条目 → mcp-client Config 形态（严格：类型不合即失败）。失败抛
 *  FileParseError，由 parseMcpFile 收进 invalid 不影响其余条目。 */
function mapEntry(name: string, value: Record<string, unknown>): McpEffectiveConfig {
  const transport = transportOf(value)
  if (transport === undefined) fail('无法判定传输形态：type 缺失且没有 command / url')

  const config: McpEffectiveConfig = { transport, serverName: name }
  if (transport === 'stdio') {
    const command = optionalString(value.command, 'command')
    if (command === undefined) fail('stdio 服务器缺少 command')
    config.command = command
    if (value.args !== undefined && value.args !== null) {
      if (!Array.isArray(value.args) || value.args.some((item) => typeof item !== 'string')) {
        fail('args 必须是字符串数组')
      }
      if (value.args.length > 0) config.args = value.args
    }
    const env = stringRecord(value.env, 'env')
    if (env !== undefined) config.env = env
    const cwd = optionalString(value.cwd, 'cwd')
    if (cwd !== undefined) config.cwd = cwd
  } else {
    const url = optionalString(value.url, 'url')
    if (url === undefined) fail('HTTP 服务器缺少 url')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      fail('url 不是合法的 URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('url 协议必须是 http 或 https')
    config.url = url
    const headers = stringRecord(value.headers, 'headers')
    if (headers !== undefined) config.headers = headers
  }
  const timeout = value.toolCallTimeoutMs
  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      fail('toolCallTimeoutMs 必须是正数（毫秒）')
    }
    config.toolCallTimeoutMs = timeout
  }
  const failOnStartupError = value.failOnStartupError
  if (failOnStartupError !== undefined && failOnStartupError !== null) {
    if (typeof failOnStartupError !== 'boolean') fail('failOnStartupError 必须是布尔值')
    config.failOnStartupError = failOnStartupError
  }
  // 未知键身份保留（reconnect 等高级键由 Loader 加载时的 schema 校验兜底）。
  for (const [key, item] of Object.entries(value)) {
    if (!STANDARD_KEYS.has(key)) config[key] = item
  }
  return config
}

/**
 * 解析 .mcp.json 文本（null = 文件不存在 → 空状态）。顶层结构问题抛
 * FileParseError；单个条目的问题收进 invalid，不影响其余条目。
 */
export function parseMcpFile(text: string | null): McpFileState {
  if (text === null || text.trim().length === 0) return emptyFileState()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    fail(`不是合法的 JSON：${errMsg(error)}`)
  }
  const root = asObject(parsed)
  if (root === undefined) fail('顶层必须是 JSON 对象')

  const state = emptyFileState()
  const wrapped = asObject(root.mcpServers)
  // mcpServers 包装为主；缺包装时接受「名称 → 配置」直接映射。
  const source = wrapped ?? root
  if (wrapped !== undefined) {
    for (const [key, value] of Object.entries(root)) {
      if (key !== 'mcpServers') state.rootExtras[key] = value
    }
  }

  for (const [rawName, value] of Object.entries(source)) {
    const name = rawName.trim()
    const entry = asObject(value)
    if (entry === undefined) {
      state.entries.set(name, {})
      state.invalid.set(name, '不是服务器配置对象')
      continue
    }
    state.entries.set(name, entry)
    if (!SERVER_NAME_PATTERN.test(name)) {
      state.invalid.set(name, `名称需匹配 ${SERVER_NAME_PATTERN.source}`)
      continue
    }
    try {
      state.valid.set(name, { config: mapEntry(name, entry), disabled: entry.disabled === true })
    } catch (error) {
      state.invalid.set(name, errMsg(error))
    }
  }
  return state
}

/** 表单草稿（mcp-client Config 形态）→ 文件条目对象（标准侧键名）。
 *  缺省值省略（disabled=false / failOnStartupError=false / 空集合不写），
 *  与 parseMcpFile 的读取端互逆。 */
export function entryFromDraft(
  config: McpConfigDraft,
  extra: Record<string, unknown> | undefined,
  disabled: boolean,
): Record<string, unknown> {
  const stdio = config.transport === 'stdio'
  const entry: Record<string, unknown> = {}
  if (!stdio) entry.type = 'http'
  entry.command = config.command
  if (config.args !== undefined && config.args.length > 0) entry.args = config.args
  if (config.env !== undefined && Object.keys(config.env).length > 0) entry.env = config.env
  if (config.cwd !== undefined && config.cwd.length > 0) entry.cwd = config.cwd
  if (!stdio) {
    entry.url = config.url
    if (config.headers !== undefined && Object.keys(config.headers).length > 0) entry.headers = config.headers
  }
  if (config.toolCallTimeoutMs !== undefined) entry.toolCallTimeoutMs = config.toolCallTimeoutMs
  if (config.failOnStartupError === true) entry.failOnStartupError = true
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (!STANDARD_KEYS.has(key)) entry[key] = value
    }
  }
  if (disabled) entry.disabled = true
  // 剔除 undefined 槽位（另一形态未赋值的键）。
  for (const [key, value] of Object.entries(entry)) {
    if (value === undefined) delete entry[key]
  }
  return entry
}

/** 解析后的状态 → 文件文本（两空格缩进 + 末尾换行）。 */
export function serializeMcpFile(state: McpFileState): string {
  const root: Record<string, unknown> = { ...state.rootExtras, mcpServers: Object.fromEntries(state.entries) }
  return `${JSON.stringify(root, null, 2)}\n`
}
