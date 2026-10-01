import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-sessions',
  client: { bundle: [] },
  host: { bundle: ['fflate'] },
})
