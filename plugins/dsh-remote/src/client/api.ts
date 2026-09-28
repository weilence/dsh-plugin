/** 面板用到的桥操作（host 半侧路由一一对应）。 */

import { createBridgeClient } from '@dsh-plugins/shared/api'
import type { LocalRowsResponse, SaveRequest, StateResponse, SyncKind, TestResponse } from '../shared'

const { request } = createBridgeClient('x-dsh-remote')

export const remoteApi = {
  state(): Promise<StateResponse> {
    return request('/dsh-remote/state')
  },
  localRows(): Promise<LocalRowsResponse> {
    return request('/dsh-remote/local-rows')
  },
  save(requestBody: SaveRequest): Promise<{ id: string }> {
    return request('/dsh-remote/save', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  remove(id: string): Promise<{ removed: boolean }> {
    return request('/dsh-remote/delete', { method: 'POST', body: JSON.stringify({ id }) })
  },
  test(id: string): Promise<TestResponse> {
    return request('/dsh-remote/test', { method: 'POST', body: JSON.stringify({ id }) })
  },
  deploy(id: string): Promise<{ started: boolean }> {
    return request('/dsh-remote/deploy', { method: 'POST', body: JSON.stringify({ id }) })
  },
  connect(id: string): Promise<{ started: boolean }> {
    return request('/dsh-remote/connect', { method: 'POST', body: JSON.stringify({ id }) })
  },
  disconnect(id: string): Promise<{ started: boolean }> {
    return request('/dsh-remote/disconnect', { method: 'POST', body: JSON.stringify({ id }) })
  },
  sync(id: string, kind: SyncKind): Promise<{ started: boolean }> {
    return request('/dsh-remote/sync', { method: 'POST', body: JSON.stringify({ id, kind }) })
  },
}
