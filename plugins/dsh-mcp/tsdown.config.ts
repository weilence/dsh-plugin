import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// host half 内联 yaml 与 cordis-plugin-loader（均为 devDependency：前者编辑
// patch 文件、后者供 live.ts 运行时判定 bundle 子树）；loader 对 cordis /
// cosmokit 的引用走生产/peer 依赖自动外置——cordis 由宿主供给（peer 声明），
// cosmokit 在 dependencies 里随 npm 安装解析。名单只是内联门禁。
export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-mcp',
  host: { bundle: ['yaml', '@deepseek-ai/cordis-plugin-loader'] },
  client: {},
})
