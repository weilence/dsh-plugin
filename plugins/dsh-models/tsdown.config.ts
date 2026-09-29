import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-models',
  client: {
    entry: 'src/client/index.ts',
    // UI 原语库（dsh-client-ui-primitives）等 seed 表基座已由工厂隐式外置。
  },
  // 平台导入全部外置由宿主运行时解析；home-paths 走 peer 解析到安装闭包里的宿主副本——无状态纯路径库两副本不可区分，宿主若移出启动链会在加载时响亮报错而非静默错路径。
  host: { bundle: [] },
})
