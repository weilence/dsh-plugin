import { createBridgeClient } from '@dsh-plugins/shared/api'
import {
  SWITCH_SET_PATH,
  SWITCH_STATE_PATH,
  type SearchSwitchSetRequest,
  type SearchSwitchSetResponse,
  type SearchSwitchView,
} from '../shared'

const { request } = createBridgeClient('x-dsh-zhipu-tools')

export const switchApi = {
  state(): Promise<SearchSwitchView> {
    return request(SWITCH_STATE_PATH)
  },
  set(requestBody: SearchSwitchSetRequest): Promise<SearchSwitchSetResponse> {
    return request(SWITCH_SET_PATH, { method: 'POST', body: JSON.stringify(requestBody) })
  },
}
