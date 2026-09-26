/**
 * dsh-skills client 半侧的 HTTP 封装：与 host half（src/index.ts）四个
 * 桥端点一一对应。同源相对路径 fetch（web 与 dsh-app: 载体均适用）；
 * POST 附带自定义头，让跨站简单请求折在 CORS 预检。
 */

import type { DeleteRequest, FileResponse, ListResponse, SaveRequest, SaveResponse } from '../shared'

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
        ? { 'content-type': 'application/json', 'x-dsh-skills': '1' }
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

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value.length > 0) search.set(key, value)
  }
  const query = search.toString()
  return query.length > 0 ? `${path}?${query}` : path
}

/** 面板用到的四个桥操作。 */
export const skillsApi = {
  list(cwd: string | undefined): Promise<ListResponse> {
    return request(withQuery('/dsh-skills/list', { cwd }))
  },
  file(path: string, cwd: string | undefined): Promise<FileResponse> {
    return request(withQuery('/dsh-skills/file', { path, cwd }))
  },
  save(requestBody: SaveRequest): Promise<SaveResponse> {
    return request('/dsh-skills/save', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  delete(requestBody: DeleteRequest): Promise<{ removed: boolean }> {
    return request('/dsh-skills/delete', { method: 'POST', body: JSON.stringify(requestBody) })
  },
}

export function errMsg(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
