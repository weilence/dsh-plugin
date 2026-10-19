import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  APPLY_WEB_CONFIG_PATH,
  ENDPOINT_STATUS_PATH,
  type ApplyWebConfigBody,
  type EndpointStatusView,
} from '../shared'

const { request } = createBridgeClient('x-dsh-zhipu-tools')

export const endpointApi = {
  status(): Promise<EndpointStatusView> {
    return request(ENDPOINT_STATUS_PATH)
  },
  applyWebConfig(body: ApplyWebConfigBody): Promise<void> {
    return request(APPLY_WEB_CONFIG_PATH, { method: 'POST', body: JSON.stringify(body) })
  },
}
