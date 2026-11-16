import { createBridgeClient, withQuery } from '@dsh-plugins/shared/api'
import {
  API_HEADER,
  CLEAR_TOKEN_PATH,
  CWD_PATH,
  DELETE_PATH,
  SAVE_PATH,
  SITES_PATH,
  TEST_PATH,
  type CwdRequest,
  type SiteDraft,
  type SitesView,
  type TestResponse,
} from '../shared'

const { request } = createBridgeClient(API_HEADER)

export interface SavePayload {
  site: SiteDraft
  /** 非空才随请求发送；空串 = 保持已存值。 */
  token?: string
  /** Server / DC 的 Confluence 独立 PAT；非空才随请求发送。 */
  confluenceToken?: string
  previousName?: string
}

export const atlassianApi = {
  /** cwd 为工作区关联兜底（主视图工作目录）；缺省 = 工作区未定。 */
  sites(cwd?: string): Promise<SitesView> {
    return request(withQuery(SITES_PATH, { cwd }))
  },
  reportCwd(requestBody: CwdRequest): Promise<{ ok: boolean }> {
    return request(CWD_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  save(payload: SavePayload): Promise<SitesView> {
    return request(SAVE_PATH, { method: 'POST', body: JSON.stringify(payload) })
  },
  remove(name: string): Promise<SitesView> {
    return request(DELETE_PATH, { method: 'POST', body: JSON.stringify({ name }) })
  },
  clearToken(name: string, product: 'jira' | 'confluence'): Promise<SitesView> {
    return request(CLEAR_TOKEN_PATH, { method: 'POST', body: JSON.stringify({ name, product }) })
  },
  test(payload: { site: SiteDraft; token?: string; confluenceToken?: string }): Promise<TestResponse> {
    return request(TEST_PATH, { method: 'POST', body: JSON.stringify(payload) })
  },
}
