import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-zhipu-tools',
  client: {},
  // host half 零内联：in-box mcp-client 是运行时 peer，由宿主解析。
  host: { bundle: [] },
})
