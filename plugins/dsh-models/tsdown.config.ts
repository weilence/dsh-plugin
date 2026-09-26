// dsh-models 构建配置——只声明差异点，公共双 half 构建逻辑见
// @dsh-plugins/tsdown-config（packages/tsdown-config/src/index.ts）。

import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: 'dsh-models',
  client: {
    entry: 'src/client/index.ts',
    // UI 原语库（dsh-client-ui-primitives）等 seed 表基座已由工厂隐式外置。
  },
  // host half 不内联任何依赖：平台导入全部外置，由宿主运行时解析。
  // home-paths 以 peer 声明（见 package.json），运行期解析到安装闭包里的
  // 宿主副本——无状态纯路径库，宿主副本与私有副本不可区分，且永远与
  // 宿主路径规则同步。依赖闭包成员关系是本选择的已知契约：DSH 若将其
  // 移出启动链，插件会在加载时响亮报错（Node 解析失败），而非静默错路径。
  host: { bundle: [] },
})
