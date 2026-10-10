import { createBridgeClient, withQuery } from '@dsh-plugins/shared/api'
import {
  CHECK_PATH,
  CWD_PATH,
  DELETE_PATH,
  LIST_PATH,
  SAVE_PATH,
  SET_ENABLED_PATH,
  type CheckRequest,
  type CheckResponse,
  type CwdRequest,
  type DeleteRequest,
  type ListResponse,
  type SaveRequest,
  type SaveResponse,
  type SetEnabledRequest,
} from '../shared'

const { request } = createBridgeClient('x-dsh-mcp')

/** cwd 为工作区档定位（主视图工作目录）；缺省 = 工作区档未定。 */
export const mcpApi = {
  list(cwd?: string): Promise<ListResponse> {
    return request(withQuery(LIST_PATH, { cwd }))
  },
  reportCwd(requestBody: CwdRequest): Promise<{ ok: boolean }> {
    return request(CWD_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  save(requestBody: SaveRequest): Promise<SaveResponse> {
    return request(SAVE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  check(requestBody: CheckRequest): Promise<CheckResponse> {
    return request(CHECK_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  setEnabled(requestBody: SetEnabledRequest): Promise<{ name: string; enabled: boolean }> {
    return request(SET_ENABLED_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  delete(requestBody: DeleteRequest): Promise<{ removed: boolean }> {
    return request(DELETE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
}
