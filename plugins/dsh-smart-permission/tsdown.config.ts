import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-smart-permission',
  // host-only 插件：行为全部在 tools/pre-execute 与审批应答者，无设置面板
  host: { bundle: [] },
})
