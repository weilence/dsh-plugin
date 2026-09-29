interface ApiError extends Error {
  status: number
}

interface BridgeClient {
  request<T>(path: string, init?: RequestInit): Promise<T>
}

/** client 半侧的 HTTP 桥封装：与 host half 的桥端点一一对应；同源相对路径
 *  fetch（web 与 dsh-app: 载体均适用）。header 为插件级自定义头名（如
 *  'x-dsh-mcp'），POST 时随请求发送。 */
export function createBridgeClient(header: string): BridgeClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const method = init?.method ?? 'GET'
    const response = await fetch(path, {
      ...init,
      method,
      headers:
        method === 'POST'
          ? { 'content-type': 'application/json', [header]: '1' }
          : { Accept: 'application/json' },
    })
    const text = await response.text()
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw apiError(`HTTP ${response.status}`, response.status)
    }
    if (!response.ok) {
      const message =
        typeof (body as { error?: unknown })?.error === 'string'
          ? (body as { error: string }).error
          : `HTTP ${response.status}`
      throw apiError(message, response.status)
    }
    return body as T
  }

  function apiError(message: string, status: number): ApiError {
    const error = new Error(message) as ApiError
    error.status = status
    return error
  }

  return { request }
}

export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.length > 0) search.set(key, value)
  }
  const query = search.toString()
  return query.length > 0 ? `${path}?${query}` : path
}
