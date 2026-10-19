import { createBridgeClient } from '@dsh-plugins/shared/api'
import { STATUS_PATH, WEB_CONFIG_PATH, type SetWebConfigBody, type StatusView } from '../shared'

const { request } = createBridgeClient('x-dsh-zhipu-tools')

export const configApi = {
  status(): Promise<StatusView> {
    return request(STATUS_PATH)
  },
  /** 设置智谱搜索开关；响应即写入后的最新状态视图。 */
  setWebConfig(body: SetWebConfigBody): Promise<StatusView> {
    return request(WEB_CONFIG_PATH, { method: 'POST', body: JSON.stringify(body) })
  },
}
