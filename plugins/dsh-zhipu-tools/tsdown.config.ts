import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-zhipu-tools',
  client: {
    // 允许内联的注册表依赖只有 clsx，误引入其他运行时依赖会在构建期报错，而非运行期 factory 必然崩溃。
    bundle: ['clsx'],
  },
  // host half 零内联：in-box mcp-client 是运行时 peer，由宿主解析。
  host: { bundle: [] },
})
