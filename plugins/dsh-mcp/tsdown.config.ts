import { defineDshPluginConfig } from '@dsh-plugins/tsdown-config'

// host half 内联 cordis-plugin-loader（devDependency：live.ts / mcpApply.ts
// 只用其类型与 Group 判定，对 cordis / cosmokit 的引用自动外置——cordis 由
// 宿主供给（peer 声明），cosmokit 在 dependencies 里随 npm 安装解析。名单只
// 是内联门禁。
export default defineDshPluginConfig({
  // id 恒等于 package.json name（client bundle 的 ModuleLoader 注册键）
  id: '@weilence/dsh-mcp',
  host: { bundle: ['@deepseek-ai/cordis-plugin-loader'] },
  client: {},
})
