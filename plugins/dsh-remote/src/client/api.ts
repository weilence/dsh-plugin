import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  CONNECT_PATH,
  DELETE_PATH,
  LOCAL_ROWS_PATH,
  REMOTE_INVENTORY_PATH,
  SAVE_PATH,
  STATE_PATH,
  SYNC_PATH,
  TEST_PATH,
  type LocalRowsResponse,
  type RegistryPluginInstall,
  type RemoteInventoryResponse,
  type SaveRequest,
  type StateResponse,
  type SyncKind,
  type TestResponse,
} from '../shared'

const { request } = createBridgeClient('x-dsh-remote')

export const remoteApi = {
  state(): Promise<StateResponse> {
    return request(STATE_PATH)
  },
  localRows(): Promise<LocalRowsResponse> {
    return request(LOCAL_ROWS_PATH)
  },
  save(requestBody: SaveRequest): Promise<{ id: string }> {
    return request(SAVE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  remove(id: string): Promise<{ removed: boolean }> {
    return request(DELETE_PATH, { method: 'POST', body: JSON.stringify({ id }) })
  },
  test(id: string): Promise<TestResponse> {
    return request(TEST_PATH, { method: 'POST', body: JSON.stringify({ id }) })
  },
  remoteInventory(id: string): Promise<RemoteInventoryResponse> {
    return request(REMOTE_INVENTORY_PATH, { method: 'POST', body: JSON.stringify({ id }) })
  },
  connect(id: string): Promise<{ started: boolean }> {
    return request(CONNECT_PATH, { method: 'POST', body: JSON.stringify({ id }) })
  },
  /** 勾选清单随请求直传（声明式同步的目标态）。 */
  sync(
    id: string,
    kind: SyncKind,
    names: string[],
    registryInstall?: RegistryPluginInstall,
  ): Promise<{ started: boolean }> {
    return request(SYNC_PATH, {
      method: 'POST',
      body: JSON.stringify({ id, kind, names, registryPluginInstall: registryInstall }),
    })
  },
}
