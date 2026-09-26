/**
 * dsh-skills client 半侧的 HTTP 封装：与 host half（src/index.ts）八个桥
 * 端点一一对应。请求/错误面与查询串拼接来自 @dsh-plugins/shared/api
 * （构建期内联），本文件只声明 dsh-skills 的自定义头名与端点表。
 */

import { createBridgeClient, withQuery } from '@dsh-plugins/shared/api'
import type {
  DeleteRequest,
  FileResponse,
  GitCheckRequest,
  GitCheckResponse,
  GitInstallRequest,
  GitInstallResponse,
  GitScanRequest,
  GitScanResponse,
  GitUpdateRequest,
  GitUpdateResponse,
  ListResponse,
  SaveRequest,
  SaveResponse,
} from '../shared'

const { request } = createBridgeClient('x-dsh-skills')

/** 面板用到的桥操作。scope 与列表作用域一致：'user'（缺省）只看用户根，'workspace' 只看项目根。 */
export const skillsApi = {
  list(cwd: string | undefined, scope?: 'user' | 'workspace'): Promise<ListResponse> {
    return request(withQuery('/dsh-skills/list', { cwd, scope }))
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
  gitScan(requestBody: GitScanRequest): Promise<GitScanResponse> {
    return request('/dsh-skills/git-scan', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitInstall(requestBody: GitInstallRequest): Promise<GitInstallResponse> {
    return request('/dsh-skills/git-install', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitCheck(requestBody: GitCheckRequest): Promise<GitCheckResponse> {
    return request('/dsh-skills/git-check', { method: 'POST', body: JSON.stringify(requestBody) })
  },
  gitUpdate(requestBody: GitUpdateRequest): Promise<GitUpdateResponse> {
    return request('/dsh-skills/git-update', { method: 'POST', body: JSON.stringify(requestBody) })
  },
}
