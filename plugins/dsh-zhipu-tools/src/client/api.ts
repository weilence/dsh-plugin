import { createBridgeClient } from '@dsh-plugins/shared/api'
import { APPLY_WEB_CONFIG_PATH, STATUS_PATH, type StatusView } from '../shared'

const { request } = createBridgeClient('x-dsh-zhipu-tools')

export const configApi = {
  status(): Promise<StatusView> {
    return request(STATUS_PATH)
  },
  applyWebConfig(): Promise<void> {
    return request(APPLY_WEB_CONFIG_PATH, { method: 'POST' })
  },
}
