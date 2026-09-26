/**
 * dsh-mcp client 半侧的 HTTP 封装：与 host half（src/index.ts）四个桥
 * 端点一一对应。同源相对路径 fetch（web 与 dsh-app: 载体均适用）；
 * POST 附带自定义头，让跨站简单请求折在 CORS 预检。
 */

import type { DeleteRequest, ListResponse, SaveRequest, SaveResponse, SetEnabledRequest } from '../shared'

export interface ApiError extends Error {
  status: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const method = init?.method ?? 'GET'
  const response = await fetch(path, {
    ...init,
    method,
    headers:
      method === 'POST'
        ? { 'content-type': 'application/json', 'x-dsh-mcp': '1' }
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

/** 面板用到的四个桥操作。 */
export const mcpApi = {
  list(): Promise<ListResponse> {
    return request('/dsh-mcp/list')
  },
  save(requestBody: SaveRequest): Promise<SaveResponse> {
    return request('/dsh-mcp/save', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  setEnabled(requestBody: SetEnabledRequest): Promise<{ id: string; enabled: boolean }> {
    return request('/dsh-mcp/set-enabled', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  delete(requestBody: DeleteRequest): Promise<{ removed: boolean }> {
    return request('/dsh-mcp/delete', { method: 'POST', body: JSON.stringify(requestBody) })
  },
}

export function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
