import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  CHECK_PATH,
  DELETE_PATH,
  LIST_PATH,
  SAVE_PATH,
  SET_ENABLED_PATH,
  type CheckRequest,
  type CheckResponse,
  type DeleteRequest,
  type ListResponse,
  type SaveRequest,
  type SaveResponse,
  type SetEnabledRequest,
} from '../shared'

const { request } = createBridgeClient('x-dsh-mcp')

export const mcpApi = {
  list(): Promise<ListResponse> {
    return request(LIST_PATH)
  },
  save(requestBody: SaveRequest): Promise<SaveResponse> {
    return request(SAVE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  check(requestBody: CheckRequest): Promise<CheckResponse> {
    return request(CHECK_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  setEnabled(requestBody: SetEnabledRequest): Promise<{ id: string; enabled: boolean }> {
    return request(SET_ENABLED_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  delete(requestBody: DeleteRequest): Promise<{ removed: boolean }> {
    return request(DELETE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
}
