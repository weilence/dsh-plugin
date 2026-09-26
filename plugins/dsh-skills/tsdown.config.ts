// dsh-skills 构建配置——只声明差异点，公共双 half 构建逻辑见
// @dsh-plugins/tsdown-config（packages/tsdown-config/src/index.ts）。

import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: 'dsh-skills',
  client: {
    // UI 原语库（dsh-client-ui-primitives）等 seed 表基座已由工厂隐式外置。
    // 打包校验白名单：本插件 client 无第三方注册表依赖，任何 node_modules
    // 内联都会在构建期报错，而不是运行期 factory 必炸。（workspace 源码包
    // 如 @dsh-plugins/client-ui 经 symlink 解析为相对路径，不走此门禁，
    // 构建期直接内联。）
    bundle: [],
  },
  // host half 无自带给发的库：禁止任何内联，全部外置由宿主解析
  // （运行期平台依赖均为 in-box peer，见 package.json peerDependencies；
  // dsh-home-paths 与 dsh-models 同款取舍——纯路径库解析到安装闭包里的
  // 宿主副本，宿主副本与私有副本不可区分且永远同规则）。
  host: { bundle: [] },
})
