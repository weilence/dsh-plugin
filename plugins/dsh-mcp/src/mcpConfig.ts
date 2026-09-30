import { errMsg } from '@dsh-plugins/shared'
import type { McpKey, PanelMessage } from './client/locales'
import type { McpConfigDraft, McpEffectiveConfig, McpTransport } from './shared'
import { SERVER_NAME_PATTERN } from './shared'

const KNOWN_KEYS = new Set([
  'transport',
  'serverName',
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'toolCallTimeoutMs',
  'failOnStartupError',
])

const STDIO_ONLY_KEYS = ['command', 'args', 'env', 'cwd'] as const
const HTTP_ONLY_KEYS = ['url', 'headers'] as const

export class ConfigError extends Error {
  /**
   * client 侧解析失败的词典描述子（浏览器渲染期取词）；host 校验路径只有
   * message——errMsg 过线，浏览器按 {text} 原样展示，不翻译。
   */
  readonly descriptor: PanelMessage | undefined

  constructor(message: string, descriptor?: PanelMessage) {
    super(message)
    this.descriptor = descriptor
  }
}

function fail(message: string): never {
  throw new ConfigError(message)
}

/** client 侧解析失败：message 用稳定键名（日志可读），展示经描述子取词。 */
function failKey(key: McpKey, params?: Record<string, unknown>): never {
  throw new ConfigError(key, { key, params })
}

function optionalString(source: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') fail(`${label}必须是字符串`)
  return value.length > 0 ? value : undefined
}

function stringRecord(
  source: Record<string, unknown>,
  key: string,
  label: string,
): Record<string, string> | undefined {
  const value = source[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) fail(`${label}必须是字符串映射`)
  const record: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (entryKey.length === 0) fail(`${label}的键不能为空`)
    if (typeof entryValue !== 'string') fail(`${label}["${entryKey}"] 必须是字符串`)
    record[entryKey] = entryValue
  }
  return Object.keys(record).length > 0 ? record : undefined
}

// 未知键直接拒绝：防止拼写错误的字段被静默丢弃
export function normalizeDraft(input: unknown): McpConfigDraft {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('config 必须是 JSON 对象')
  const source = input as Record<string, unknown>
  for (const key of Object.keys(source)) {
    if (!KNOWN_KEYS.has(key)) fail(`未知字段「${key}」（reconnect 等高级键请直接编辑 patch 文件）`)
  }

  const transport = source.transport
  if (transport !== 'stdio' && transport !== 'streamable-http')
    fail('transport 必须是 stdio 或 streamable-http')

  const serverName = source.serverName
  if (typeof serverName !== 'string' || !SERVER_NAME_PATTERN.test(serverName)) {
    fail('serverName 需匹配 ^[A-Za-z0-9_-]{1,32}$（将作为模型侧工具名前缀 mcp__<serverName>__*）')
  }

  const draft: McpConfigDraft = { transport, serverName }

  if (transport === 'stdio') {
    const command = optionalString(source, 'command', 'command')
    if (command === undefined) fail('stdio 传输需要 command（可执行文件）')
    draft.command = command
    const args = source.args
    if (args !== undefined && args !== null) {
      if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) fail('args 必须是字符串数组')
      if (args.length > 0) draft.args = args
    }
    const env = stringRecord(source, 'env', 'env')
    if (env !== undefined) draft.env = env
    const cwd = optionalString(source, 'cwd', 'cwd')
    if (cwd !== undefined) draft.cwd = cwd
  } else {
    const url = optionalString(source, 'url', 'url')
    if (url === undefined) fail('streamable-http 传输需要 url（MCP 端点）')
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      fail('url 不是合法的 URL')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail('url 协议必须是 http 或 https')
    draft.url = url
    const headers = stringRecord(source, 'headers', 'headers')
    if (headers !== undefined) draft.headers = headers
  }

  const timeout = source.toolCallTimeoutMs
  if (timeout !== undefined && timeout !== null) {
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
      fail('toolCallTimeoutMs 必须是正数（毫秒）')
    }
    draft.toolCallTimeoutMs = timeout
  }
  const failOnStartupError = source.failOnStartupError
  if (failOnStartupError !== undefined && failOnStartupError !== null) {
    if (typeof failOnStartupError !== 'boolean') fail('failOnStartupError 必须是布尔值')
    draft.failOnStartupError = failOnStartupError
  }
  return draft
}

/**
 * 编辑合并：以 insert 声明为保留底座（未知键 / 高级键在此），生效配置
 * 的键覆盖其上（覆盖行的已知值才是运行事实），最后叠加草稿的已知键；
 * transport 切换时把另一形态的专属键清掉。
 */
export function mergeForEdit(
  existing: (Record<string, unknown> | undefined)[],
  draft: McpConfigDraft,
): McpEffectiveConfig {
  const otherKeys: readonly string[] = draft.transport === 'stdio' ? HTTP_ONLY_KEYS : STDIO_ONLY_KEYS
  const merged: Record<string, unknown> = {}
  for (const base of existing) {
    for (const [key, value] of Object.entries(base ?? {})) {
      merged[key] = value
    }
  }
  for (const key of otherKeys) delete merged[key]
  for (const [key, value] of Object.entries(draft)) {
    if (value !== undefined) merged[key] = value
  }
  return merged as McpEffectiveConfig
}

export function endpointOf(config: McpConfigDraft | McpEffectiveConfig): string {
  if (config.transport === 'stdio') {
    const parts = [
      typeof config.command === 'string' ? config.command : '',
      ...(Array.isArray(config.args) ? (config.args as unknown[]) : []),
    ]
    return parts.filter((part) => typeof part === 'string' && part.length > 0).join(' ')
  }
  return typeof config.url === 'string' ? config.url : ''
}

/** JSON 导入解析出的一个服务器：已知键草稿 + 未知键透传 + 提示。 */
export interface McpJsonEntry {
  /** 服务器名：mcpServers / 直接映射的键名，或单个服务器对象自动推导的名称。 */
  serverName: string
  draft: McpConfigDraft
  /** 表单外的高级键原样透传（host 合并进 patch，由 Loader 加载时校验）。 */
  extras: Record<string, unknown>
  notes: string[]
}

export interface McpJsonParseResult {
  entries: McpJsonEntry[]
  /** 单台服务器的问题用词典描述子表达，渲染期随宿主语言取词。 */
  problems: { name: string; message: PanelMessage }[]
}

/** Agent Plugins 的 ${PLUGIN_ROOT} 类占位符：DSH 无插件根概念，无法解析。 */
const PLACEHOLDER_PATTERN = /\$\{[A-Za-z0-9_]+\}/

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return PLACEHOLDER_PATTERN.test(value)
  if (Array.isArray(value)) return value.some(hasPlaceholder)
  if (typeof value === 'object' && value !== null) return Object.values(value).some(hasPlaceholder)
  return false
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === 'string')
}

/** 按 type 字段（缺省按 command/url 推断）归一到两种传输形态。 */
function transportOfEntry(value: Record<string, unknown>, notes: string[]): McpTransport | undefined {
  const type = value.type
  if (type === 'stdio') return 'stdio'
  if (type === 'streamable-http' || type === 'http') return 'streamable-http'
  if (type === 'sse') {
    notes.push('HTTP+SSE 传输已弃用，按 streamable-http 处理')
    return 'streamable-http'
  }
  if (type === undefined) {
    if (value.command !== undefined) return 'stdio'
    if (value.url !== undefined) return 'streamable-http'
  }
  return undefined
}

/** 从一个服务器对象抽出已知键草稿（类型不合的键跳过，交由 host 严格校验）。 */
function draftOfEntry(name: string, value: Record<string, unknown>, transport: McpTransport): McpConfigDraft {
  const draft: McpConfigDraft = { transport, serverName: name }
  if (transport === 'stdio') {
    if (typeof value.command === 'string' && value.command.length > 0) draft.command = value.command
    if (
      Array.isArray(value.args) &&
      value.args.length > 0 &&
      value.args.every((item) => typeof item === 'string')
    ) {
      draft.args = value.args
    }
    if (isStringRecord(value.env)) draft.env = value.env
    if (typeof value.cwd === 'string' && value.cwd.length > 0) draft.cwd = value.cwd
  } else {
    if (typeof value.url === 'string' && value.url.length > 0) draft.url = value.url
    if (isStringRecord(value.headers)) draft.headers = value.headers
  }
  if (
    typeof value.toolCallTimeoutMs === 'number' &&
    Number.isFinite(value.toolCallTimeoutMs) &&
    value.toolCallTimeoutMs > 0
  ) {
    draft.toolCallTimeoutMs = value.toolCallTimeoutMs
  }
  if (typeof value.failOnStartupError === 'boolean') draft.failOnStartupError = value.failOnStartupError
  return draft
}

// 解析粘贴的 JSON，名称一律来自 JSON 本身：mcpServers 包装 / 直接映射 /
// 单个服务器对象（名称从 command 或 URL 推导）三种等价写法（方言细节见
// mcpImport.test.ts）。顶层结构问题抛带词典描述子的 ConfigError；单个服务
// 器的问题进 problems 不影响其余。
export function parseMcpJsonText(text: string): McpJsonParseResult {
  const trimmed = text.trim()
  if (trimmed.length === 0) failKey('import.emptyInput')
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    failKey('import.invalidJson', { detail: errMsg(error) })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    failKey('import.rootNotObject')
  }
  const root = parsed as Record<string, unknown>
  const entries: McpJsonEntry[] = []
  const problems: { name: string; message: PanelMessage }[] = []

  const consume = (name: string, value: Record<string, unknown>, prefixNote?: string): void => {
    const notes: string[] = prefixNote === undefined ? [] : [prefixNote]
    if (!SERVER_NAME_PATTERN.test(name)) {
      problems.push({ name, message: { key: 'import.namePattern', params: { name } } })
      return
    }
    if (hasPlaceholder(value)) {
      problems.push({ name, message: { key: 'import.placeholder' } })
      return
    }
    const transport = transportOfEntry(value, notes)
    if (transport === undefined) {
      problems.push({ name, message: { key: 'import.transportUnknown' } })
      return
    }
    const draft = draftOfEntry(name, value, transport)
    if (transport === 'stdio' && draft.command === undefined) {
      problems.push({ name, message: { key: 'import.stdioCommandMissing' } })
      return
    }
    if (transport === 'streamable-http' && draft.url === undefined) {
      problems.push({ name, message: { key: 'import.httpUrlMissing' } })
      return
    }
    const otherKeys = transport === 'stdio' ? HTTP_ONLY_KEYS : STDIO_ONLY_KEYS
    const dropped = otherKeys.filter((field) => value[field] !== undefined)
    if (dropped.length > 0)
      notes.push(`已忽略 ${transport === 'stdio' ? 'HTTP' : 'stdio'} 专属键：${dropped.join(' / ')}`)
    const extras: Record<string, unknown> = {}
    for (const [field, fieldValue] of Object.entries(value)) {
      if (field !== 'type' && !KNOWN_KEYS.has(field)) extras[field] = fieldValue
    }
    entries.push({ serverName: name, draft, extras, notes })
  }

  const asServerObject = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined

  const wrapped = root.mcpServers
  if (asServerObject(wrapped) !== undefined) {
    const map = wrapped as Record<string, unknown>
    if (Object.keys(map).length === 0) failKey('import.emptyServers')
    for (const [key, value] of Object.entries(map)) {
      const server = asServerObject(value)
      if (server === undefined) problems.push({ name: key, message: { key: 'import.notServerObject' } })
      else consume(key.trim(), server)
    }
  } else if (
    wrapped === undefined &&
    ['command', 'url', 'type', 'transport'].some((key) => root[key] !== undefined)
  ) {
    const derived = deriveServerName(root)
    if (derived === undefined) {
      problems.push({ name: '', message: { key: 'import.deriveFailed' } })
    } else {
      consume(derived, root, `已自动命名 ${derived}（如需自定义名称，请用 {"服务器名": {...}} 包装）`)
    }
  } else {
    let seen = false
    for (const [key, value] of Object.entries(root)) {
      const server = asServerObject(value)
      if (server === undefined) {
        problems.push({ name: key, message: { key: 'import.notServerObjectSparse' } })
        continue
      }
      seen = true
      consume(key.trim(), server)
    }
    if (!seen && problems.length === 0) {
      failKey('import.noServers')
    }
  }
  return { entries, problems }
}

/** 单个服务器对象的回退命名：command 主干（去路径与 .exe 等）或 URL 主机名，
 * 清洗到 SERVER_NAME_PATTERN 文法；推不出来返回 undefined。 */
function deriveServerName(value: Record<string, unknown>): string | undefined {
  let raw: string | undefined
  if (typeof value.command === 'string' && value.command.length > 0) {
    raw = value.command
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.(exe|cmd|bat)$/i, '')
  } else if (typeof value.url === 'string' && value.url.length > 0) {
    try {
      raw = new URL(value.url).hostname
    } catch {
      raw = undefined
    }
  }
  if (raw === undefined || raw.length === 0) return undefined
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return cleaned.length > 0 ? cleaned : undefined
}

/**
 * host 侧过滤 JSON 导入的透传键：剔除与已知键同名的项（防绕过草稿
 * 校验），非对象输入或缺失时返回 undefined。
 */
export function extrasOf(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!KNOWN_KEYS.has(key) && key !== 'type') result[key] = value
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function transportOf(config: Record<string, unknown>): McpTransport | undefined {
  return config.transport === 'stdio' || config.transport === 'streamable-http' ? config.transport : undefined
}
