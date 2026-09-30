import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

export const ZHIPU_SEARCH_PROVIDER_ID = 'zhipu'
const SEARCH_URL = 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp'
const TOOL_NAMES = new Set(['web_search_prime', 'webSearchPrime'])
const REQUEST_TIMEOUT_MS = 30_000
const MAX_RESULT_CHARS = 200_000

function searchError(message: string, cause?: unknown): WebError {
  return new WebError(message, 'WEB_PROVIDER_ERROR', cause === undefined ? undefined : { cause })
}

function safeSearchText(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').replace(/[\\\[\]()*_`]/g, '\\$&')
}

function sourceFrom(value: unknown): WebSearchSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw searchError('智谱搜索返回了非对象来源')
  }
  const source = value as Record<string, unknown>
  const rawUrl = source.link ?? source.url
  if (typeof rawUrl !== 'string') throw searchError('智谱搜索结果缺少 URL')
  if (rawUrl !== rawUrl.trim() || /[\u0000-\u001f\u007f]/.test(rawUrl)) {
    throw searchError('智谱搜索结果的 URL 含空白或控制字符')
  }
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch (error) {
    throw searchError(`智谱搜索结果的 URL 无效：${rawUrl}`, error)
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw searchError(`智谱搜索结果的 URL 不是公开 HTTP(S) 地址：${rawUrl}`)
  }
  if (source.title !== undefined && typeof source.title !== 'string') {
    throw searchError(`智谱搜索结果 ${rawUrl} 的标题不是字符串`)
  }
  if (source.content !== undefined && typeof source.content !== 'string') {
    throw searchError(`智谱搜索结果 ${rawUrl} 的摘要不是字符串`)
  }
  return {
    url: url.href.replace(/\(/g, '%28').replace(/\)/g, '%29'),
    ...(typeof source.title === 'string' && source.title ? { title: safeSearchText(source.title) } : {}),
    ...(typeof source.content === 'string' && source.content
      ? { snippet: safeSearchText(source.content) }
      : {}),
  }
}

/** 一句话描述未知形状（诊断用，不展开内容）。 */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return `数组(${value.length} 项)`
  if (typeof value === 'object' && value !== null) {
    return `对象(${Object.keys(value).slice(0, 5).join(', ')})`
  }
  return typeof value
}

export function parseSearchResult(result: {
  isError?: boolean
  structuredContent?: unknown
  content: readonly { type: string; text?: string }[]
}): WebSearchResult {
  if (result.isError) {
    const detail = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
    throw searchError(`智谱搜索失败：${detail || '远端工具未提供错误详情'}`)
  }
  // 实测稳定契约：单一 text 块承载来源数组，且被再包了一层 JSON 字符串
  // （text = "\"[{...}]\""）；structuredContent 真实存在但为未公开的包装
  // 对象——仅当它直接是数组时采用，不猜测包装键名。
  let data: unknown
  if (result.content.length === 1 && result.content[0]?.type === 'text') {
    const text = result.content[0].text
    if (typeof text === 'string' && text.length <= MAX_RESULT_CHARS) {
      try {
        let parsed: unknown = JSON.parse(text)
        if (typeof parsed === 'string' && parsed.length <= MAX_RESULT_CHARS) {
          try {
            parsed = JSON.parse(parsed)
          } catch {
            // 第二层不是 JSON：保留第一层结果，走数组判定统一报错。
          }
        }
        data = parsed
      } catch {
        // 文本不是 JSON 时落到 structuredContent 分支再统一报错。
      }
    }
  }
  if (!Array.isArray(data) && Array.isArray(result.structuredContent)) {
    data = result.structuredContent
  }
  if (!Array.isArray(data)) {
    throw searchError(
      `智谱搜索结果不是来源列表（文本 ${describeShape(data)}，structuredContent ${describeShape(result.structuredContent)}）`,
    )
  }
  if (JSON.stringify(data).length > MAX_RESULT_CHARS) throw searchError('智谱搜索结果超过大小限制')
  return { sources: data.map(sourceFrom), truncated: false }
}

export function createZhipuSearchProvider(
  resolveKey: () => Promise<string>,
  endpoint = SEARCH_URL,
): WebSearchProvider {
  return {
    id: ZHIPU_SEARCH_PROVIDER_ID,
    available: () => true,
    async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
      if (signal?.aborted) throw new WebError('智谱搜索已取消', 'WEB_ABORTED')
      const key = await resolveKey()
      if (signal?.aborted) throw new WebError('智谱搜索已取消', 'WEB_ABORTED')
      const client = new Client({ name: 'dsh-zhipu-tools', version: '0.1.0' })
      const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { Authorization: `Bearer ${key}` }, redirect: 'error' },
      })
      try {
        await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT_MS })
        const { tools } = await client.listTools(undefined, { signal, timeout: REQUEST_TIMEOUT_MS })
        const candidates = tools.filter((tool) => TOOL_NAMES.has(tool.name))
        if (candidates.length !== 1) {
          throw searchError(`智谱搜索工具发现失败：期望一个搜索工具，实际找到 ${candidates.length} 个`)
        }
        const tool = candidates[0]!
        const querySchema = tool.inputSchema.properties?.search_query
        if (
          !tool.inputSchema.required?.includes('search_query') ||
          typeof querySchema !== 'object' ||
          querySchema === null ||
          Array.isArray(querySchema) ||
          (querySchema as Record<string, unknown>).type !== 'string'
        ) {
          throw searchError(`智谱搜索工具 ${tool.name} 的 search_query 参数不符合预期`)
        }
        const result = await client.callTool(
          { name: tool.name, arguments: { search_query: request.query } },
          { signal, timeout: REQUEST_TIMEOUT_MS, toolDefinition: tool },
        )
        return parseSearchResult(result)
      } catch (error) {
        if (signal?.aborted) throw new WebError('智谱搜索已取消', 'WEB_ABORTED', { cause: error })
        if (error instanceof WebError) throw error
        throw searchError(`智谱搜索请求失败：${String(error)}`, error)
      } finally {
        await client.close()
      }
    },
  }
}
