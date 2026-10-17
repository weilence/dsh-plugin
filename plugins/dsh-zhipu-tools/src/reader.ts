import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { WebError } from '@deepseek-ai/dsh-web'

const READER_URL = 'https://open.bigmodel.cn/api/mcp/web_reader/mcp'
// 官方文档的工具名是 webReader；与搜索侧同理，接受驼峰 / 蛇形两种拼写。
const TOOL_NAMES = new Set(['webReader', 'web_reader'])
const REQUEST_TIMEOUT_MS = 60_000
const MAX_CONTENT_CHARS = 2_000_000

function readerError(message: string, cause?: unknown): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })
}

/** 一句话描述未知形状（诊断用，不展开内容）。 */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `数组(${value.length} 项)`
  if (typeof value === 'object' && value !== null) {
    return `对象(${Object.keys(value).slice(0, 5).join(', ')})`
  }
  return typeof value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从候选 JSON 对象里取正文：HTTP 契约是 reader_result.content，MCP 可能摊平。 */
function contentFrom(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  if (typeof data.content === 'string') return data.content
  const nested = data.reader_result
  if (isRecord(nested) && typeof nested.content === 'string') return nested.content
  return undefined
}

/**
 * 严格解析 webReader 的工具结果。取正文的候选形状按序：
 * 单文本块的 JSON（可双层编码）里的 `content` / `reader_result.content`
 * （HTTP 契约嵌套层）→ 非整 JSON 的单文本块本身（MCP 可能直接回 Markdown）
 * → structuredContent。空正文与无正文字段的形状明确报错，不伪装成空页
 * （对齐官方 Fetch API「目标无可用内容即失败」的语义）。
 */
export function parseReaderContent(result: {
  isError?: boolean
  structuredContent?: unknown
  content: readonly { type: string; text?: string }[]
}): string {
  if (result.isError) {
    const detail = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    throw readerError(`智谱网页阅读失败：${detail || '远端工具未提供错误详情'}`)
  }
  let data: unknown
  if (result.content.length === 1 && result.content[0]?.type === 'text') {
    const text = result.content[0].text
    if (typeof text === 'string' && text.length <= MAX_CONTENT_CHARS) {
      try {
        let parsed: unknown = JSON.parse(text)
        if (typeof parsed === 'string' && parsed.length <= MAX_CONTENT_CHARS) {
          try {
            parsed = JSON.parse(parsed)
          } catch {
            // 第二层不是 JSON：保留第一层字符串，按正文候选处理。
          }
        }
        data = parsed
      } catch {
        // 不是 JSON：整个文本块视为 Markdown 正文候选。
        data = text
      }
    }
  }
  let content: string | undefined
  if (typeof data === 'string') content = data
  else if (isRecord(data)) content = contentFrom(data)
  if (content === undefined && isRecord(result.structuredContent))
    content = contentFrom(result.structuredContent)
  if (content === undefined) {
    throw readerError(
      `智谱网页阅读结果没有正文字段（文本 ${describeShape(data)}，structuredContent ${describeShape(result.structuredContent)}）`,
    )
  }
  if (content.trim().length === 0) throw readerError('智谱网页阅读返回了空正文（目标页可能没有可提取内容）')
  if (content.length > MAX_CONTENT_CHARS) throw readerError('智谱网页阅读正文超过大小限制')
  return content
}

/** 一次智谱网页阅读：入参是目标 URL，返回 Markdown 正文。 */
export type ZhipuReader = (url: string, signal?: AbortSignal) => Promise<string>

export function createZhipuReader(resolveKey: () => Promise<string>, endpoint = READER_URL): ZhipuReader {
  return async (url, signal): Promise<string> => {
    if (signal?.aborted) throw new WebError('智谱网页阅读已取消', 'WEB_ABORTED')
    const key = await resolveKey()
    if (signal?.aborted) throw new WebError('智谱网页阅读已取消', 'WEB_ABORTED')
    const client = new Client({ name: 'dsh-zhipu-tools', version: '0.1.0' })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${key}` }, redirect: 'error' },
    })
    try {
      await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS })
      const { tools } = await client.listTools(undefined, { signal, timeout: REQUEST_TIMEOUT_MS })
      const candidates = tools.filter((tool) => TOOL_NAMES.has(tool.name))
      if (candidates.length !== 1) {
        throw readerError(`智谱网页阅读工具发现失败：期望一个阅读工具，实际找到 ${candidates.length} 个`)
      }
      const tool = candidates[0]!
      const urlSchema = tool.inputSchema.properties?.url
      if (
        !tool.inputSchema.required?.includes('url') ||
        typeof urlSchema !== 'object' ||
        urlSchema === null ||
        Array.isArray(urlSchema) ||
        (urlSchema as Record<string, unknown>).type !== 'string'
      ) {
        throw readerError(`智谱网页阅读工具 ${tool.name} 的 url 参数不符合预期`)
      }
      const result = await client.callTool(
        { name: tool.name, arguments: { url } },
        { signal, timeout: REQUEST_TIMEOUT_MS, toolDefinition: tool },
      )
      return parseReaderContent(result)
    } catch (error) {
      if (signal?.aborted) throw new WebError('智谱网页阅读已取消', 'WEB_ABORTED', { cause: error })
      if (error instanceof WebError) throw error
      throw readerError(`智谱网页阅读请求失败：${String(error)}`, error)
    } finally {
      await client.close()
    }
  }
}
