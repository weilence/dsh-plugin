import { HttpError } from '@dsh-plugins/shared/http'
import type { ProductSite } from './shared'

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** 单次 Atlassian REST 请求的软超时；配合工具管道的协作取消语义。 */
const REQUEST_TIMEOUT_MS = 30_000

export function authHeaders(site: ProductSite, token: string): Record<string, string> {
  if (site.kind === 'cloud') {
    const encoded = Buffer.from(`${site.email ?? ''}:${token}`, 'utf8').toString('base64')
    return { authorization: `Basic ${encoded}` }
  }
  return { authorization: `Bearer ${token}` }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** HTTP 状态 → 面向模型/面板的明确失败；detail 取响应里的错误消息。 */
async function statusError(response: Response, path: string): Promise<HttpError> {
  const raw = await response.text().catch(() => '')
  let detail = ''
  try {
    const parsed = JSON.parse(raw) as { errorMessages?: unknown; message?: unknown }
    if (textOf(parsed.message) !== '') detail = textOf(parsed.message)
    else if (Array.isArray(parsed.errorMessages)) {
      detail = parsed.errorMessages.filter((item) => typeof item === 'string').join('；')
    }
  } catch {
    detail = raw.slice(0, 200)
  }
  const suffix = detail !== '' ? `：${detail}` : ''
  if (response.status === 401 || response.status === 403) {
    return new HttpError(response.status, `凭据无效或权限不足（HTTP ${response.status}）${suffix}`)
  }
  if (response.status === 404) return new HttpError(404, `未找到（HTTP 404）${suffix}`)
  if (response.status === 429)
    return new HttpError(429, `Atlassian 速率受限（HTTP 429），请稍后重试${suffix}`)
  return new HttpError(response.status, `Atlassian 请求失败（HTTP ${response.status}）${suffix}`)
}

/** 认证头 + 软超时 + 错误映射，Jira / Confluence 两个 client 共用。 */
export function createRestClient(site: ProductSite, token: string, fetchImpl: FetchLike = fetch) {
  const base = site.url.replace(/\/+$/, '')

  /** 公共管道：超时/取消合流 + 认证头 + 状态映射，返回原始 Response 供 JSON / 二进制分头消费。 */
  async function send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    const onAbort = (): void => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: { accept: 'application/json', ...authHeaders(site, token), ...(init.headers ?? {}) },
        signal: controller.signal,
      })
      if (!response.ok) throw await statusError(response, url)
      return response
    } catch (error) {
      // 调用方取消要保留 AbortError 形态（宿主管道按其落 ABORTED 结果）。
      if (signal?.aborted) throw error
      if (timedOut) throw new HttpError(504, `Atlassian 请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`)
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  async function request(path: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const response = await send(`${base}${path}`, init, signal)
    return (await response.json()) as unknown
  }

  return {
    async get(path: string, signal?: AbortSignal): Promise<unknown> {
      return request(path, { method: 'GET' }, signal)
    },
    async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
      return request(
        path,
        { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } },
        signal,
      )
    },
    /** 二进制下载：附件 content 是绝对 URL（认证在宿主域内），返回 Buffer。 */
    async getBinary(url: string, signal?: AbortSignal): Promise<Buffer> {
      const response = await send(url, { method: 'GET' }, signal)
      return Buffer.from(await response.arrayBuffer())
    },
  }
}

export type RestClient = ReturnType<typeof createRestClient>
