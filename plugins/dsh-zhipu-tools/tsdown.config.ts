import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-zhipu-tools',
  // host half 内联 yaml：端点状态文件经 @dsh-plugins/shared/patch 的原子写
  // 落盘（该模块顶层依赖 yaml）；cordis / cosmokit 走生产/peer 依赖自动外置
  // ——cordis 由宿主供给（peer 声明），cosmokit 在 dependencies 里随 npm 安装解析。
  host: { bundle: ['yaml'] },
  client: { entry: 'src/client/index.ts' },
})
