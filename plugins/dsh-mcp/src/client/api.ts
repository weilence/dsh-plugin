/**
 * dsh-mcp client 半侧的 HTTP 封装：与 host half（src/index.ts）四个桥
 * 端点一一对应。请求/错误面来自 @dsh-plugins/shared/api（构建期内联），
 * 本文件只声明 dsh-mcp 的自定义头名与端点表。
 */

import { createBridgeClient } from '@dsh-plugins/shared/api'
import type { DeleteRequest, ListResponse, SaveRequest, SaveResponse, SetEnabledRequest } from '../shared'

const { request } = createBridgeClient('x-dsh-mcp')

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
