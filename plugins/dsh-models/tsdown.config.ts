import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  id: '@weilence/dsh-models',
  client: {
    entry: 'src/client/index.ts',
    // dayjs（相对时间）随 client bundle 内联；必须声明在 devDependencies——
    // tsdown 默认外置 dependencies，外置的 require 进不了宿主模块表，启动即失败。
    bundle: ['dayjs'],
    // UI 原语库（dsh-client-ui-primitives）等 seed 表基座已由工厂隐式外置。
  },
  // 平台导入全部外置由宿主运行时解析；home-paths 走 peer 解析到安装闭包里的宿主副本——无状态纯路径库两副本不可区分，宿主若移出启动链，加载时会明确报错，而非静默使用错误路径。
  host: { bundle: [] },
})
