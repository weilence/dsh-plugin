// dsh-zhipu-tools 构建配置——只声明差异点，公共双 half 构建逻辑见
// @dsh-plugins/tsdown-config（packages/tsdown-config/src/index.ts）。

import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-zhipu-tools',
  client: {
    // UI 原语库（dsh-client-ui-primitives）等 seed 表基座已由工厂隐式外置。
    // 允许内联的注册表依赖只有 clsx；将来误引入其他运行时依赖会在构建期
    // 报错，而不是运行期 factory 必炸。（workspace 源码包如
    // @dsh-plugins/client-ui 经 symlink 解析为相对路径，不走此门禁，
    // 构建期直接内联。）
    bundle: ['clsx'],
  },
  // host half 无自带给发的库：禁止任何内联，全部外置由宿主解析——in-box
  // mcp-client 是运行时 peer，见 package.json peerDependencies。
  host: { bundle: [] },
})
