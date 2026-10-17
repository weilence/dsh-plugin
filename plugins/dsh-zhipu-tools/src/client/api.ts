import { createBridgeClient } from '@dsh-plugins/shared/api'
import { ENDPOINT_STATUS_PATH, type EndpointStatusView } from '../shared'

const { request } = createBridgeClient('x-dsh-zhipu-tools')

export const endpointApi = {
  status(): Promise<EndpointStatusView> {
    return request(ENDPOINT_STATUS_PATH)
  },
}
