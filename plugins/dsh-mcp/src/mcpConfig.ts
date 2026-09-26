/**
 * MCP 服务器配置的校验与归一：以官方 mcp-client 的 Config schema
 * （packages/mcp/mcp-client/src/index.ts）为依据做前置校验，最终仍由
 * Loader 加载时的 Schemastery 校验兜底。
 *
 * 编辑合并规则：客户端只提交已知键；现有生效配置里的未知键
 * （reconnect / maxInstructionBytes 等）原样保留，切换 transport 时丢弃
 * 另一传输形态的专属键，避免留下 schema union 之外的死配置。
 */

import type { McpConfigDraft, McpEffectiveConfig, McpTransport } from './shared'
import { SERVER_NAME_PATTERN } from './shared'

/** 客户端可提交的全部已知键。 */
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

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message)
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

/**
 * 校验客户端提交的草稿并归一为只含已定义键的对象；请求里出现未知键
 * 直接拒绝（防止拼写错误的字段被静默丢弃）。
 */
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
      return draft
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

/** 草稿的展示端点（列表/卡片一行摘要）。 */
export function endpointOf(config: Record<string, unknown>): string {
  if (config.transport === 'stdio') {
    const parts = [
      typeof config.command === 'string' ? config.command : '',
      ...(Array.isArray(config.args) ? (config.args as unknown[]) : []),
    ]
    return parts.filter((part) => typeof part === 'string' && part.length > 0).join(' ')
  }
  return typeof config.url === 'string' ? config.url : ''
}

/** 归一后的最小传输类型（供展示）。 */
export function transportOf(config: Record<string, unknown>): McpTransport | undefined {
  return config.transport === 'stdio' || config.transport === 'streamable-http' ? config.transport : undefined
}
