import { createBridgeClient, withQuery } from '@dsh-plugins/shared/api'
import {
  API_HEADER,
  CWD_PATH,
  DELETE_PATH,
  SAVE_PATH,
  SITES_PATH,
  TEST_PATH,
  type CwdRequest,
  type SaveRequest,
  type SiteDraft,
  type SitesView,
  type TestResponse,
} from '../shared'

const { request } = createBridgeClient(API_HEADER)

export interface SavePayload {
  site: SiteDraft
  previousName?: string
}

export const gitlabApi = {
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
  test(payload: { site: SiteDraft }): Promise<TestResponse> {
    return request(TEST_PATH, { method: 'POST', body: JSON.stringify(payload) })
  },
}
