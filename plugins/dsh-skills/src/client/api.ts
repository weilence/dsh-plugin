import { createBridgeClient, withQuery } from '@dsh-plugins/shared/api'
import {
  DELETE_PATH,
  FILE_PATH,
  GIT_CHECK_PATH,
  GIT_INSTALL_PATH,
  GIT_SCAN_PATH,
  GIT_UPDATE_PATH,
  LIST_PATH,
  SAVE_PATH,
  type DeleteRequest,
  type FileResponse,
  type GitCheckRequest,
  type GitCheckResponse,
  type GitInstallRequest,
  type GitInstallResponse,
  type GitScanRequest,
  type GitScanResponse,
  type GitUpdateRequest,
  type GitUpdateResponse,
  type ListResponse,
  type SaveRequest,
  type SaveResponse,
} from '../shared'

const { request } = createBridgeClient('x-dsh-skills')

/** scope 与列表作用域一致：'user'（缺省）只看用户根，'workspace' 只看项目根。 */
export const skillsApi = {
  list(cwd: string | undefined, scope?: 'user' | 'workspace'): Promise<ListResponse> {
    return request(withQuery(LIST_PATH, { cwd, scope }))
  },
  file(path: string, cwd: string | undefined): Promise<FileResponse> {
    return request(withQuery(FILE_PATH, { path, cwd }))
  },
  save(requestBody: SaveRequest): Promise<SaveResponse> {
    return request(SAVE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  delete(requestBody: DeleteRequest): Promise<{ removed: boolean }> {
    return request(DELETE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitScan(requestBody: GitScanRequest): Promise<GitScanResponse> {
    return request(GIT_SCAN_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitInstall(requestBody: GitInstallRequest): Promise<GitInstallResponse> {
    return request(GIT_INSTALL_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitCheck(requestBody: GitCheckRequest): Promise<GitCheckResponse> {
    return request(GIT_CHECK_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitUpdate(requestBody: GitUpdateRequest): Promise<GitUpdateResponse> {
    return request(GIT_UPDATE_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
}
