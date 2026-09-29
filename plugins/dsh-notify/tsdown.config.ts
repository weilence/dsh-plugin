import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-notify',
  client: {
    // 本插件 client 无第三方注册表依赖：白名单留空，误内联在构建期报错而非运行期 factory 必炸。
    bundle: [],
  },
  // host half 无自带给发的库，全部外置由宿主解析（in-box peer）。
  host: { bundle: [] },
})
